import { encodeAbiParameters, keccak256, zeroAddress } from 'viem';
import { CELESTE } from '../onehive/addresses.js';
import { agreementAbi, agreementChallengeStates, agreementResolutionAbi } from '../onehive/abis/agreement.js';
import { adapterAbi, classicAbi, coreAbi, sortitionAbi } from './abis.js';
import type { DisputeCommand } from './commands.js';
import { preview, sortitionAddress } from './preview.js';
import { requireThat, type Snapshot } from './snapshot.js';

const periods = ['evidence', 'commit', 'vote', 'appeal', 'execution'] as const;
const choices = { refuse: 0n, challenger: 1n, submitter: 2n } as const;
const outcomes = ['voided', 'rejected', 'accepted'] as const;

function readCase(s: Snapshot, r: DisputeCommand) {
  const [actionId, challenger, , challengeContext, , state, , , adapterId, recordedRuling] = s.read(agreementAbi, r.agreement, 'getChallenge', [r.challengeId]);
  const challengeState = agreementChallengeStates[state]?.toLowerCase();
  requireThat(challengeState && state >= 2, 'Challenge has no arbitrated dispute.');
  const [app, appActionId, collateralId, settingId, submitter, closed, actionContext, lastChallenge, active] = s.read(agreementAbi, r.agreement, 'getAction', [actionId]);
  requireThat(app !== zeroAddress, 'Unknown Agreement action.');
  if (state === 2) requireThat(!closed && active && lastChallenge === r.challengeId, 'Active challenge/action linkage mismatch.');
  const [arbitrator] = s.read(agreementResolutionAbi, r.agreement, 'getSetting', [settingId]);
  requireThat(arbitrator === r.adapter && arbitrator.toLowerCase() !== CELESTE.COURT.toLowerCase(),
    'The action’s saved Agreement setting must designate the expected Kleros adapter.');
  requireThat(s.read(adapterAbi, r.adapter, 'core', []) === r.core &&
    s.read(adapterAbi, r.adapter, 'agreement', []) === r.agreement &&
    s.read(adapterAbi, r.adapter, 'honey', []) === r.honey, 'Agreement adapter binding mismatch.');
  const [coreId, adapterRuling, exists, finalised] = s.read(adapterAbi, r.adapter, 'disputes', [adapterId]);
  const expectedId = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [r.adapter, coreId])));
  requireThat(exists && adapterId === expectedId &&
    s.read(adapterAbi, r.adapter, 'agreementDisputeByCore', [coreId]) === adapterId, 'Adapter dispute ID mapping mismatch.');
  const [courtId, arbitrated, periodId, ruled, lastChange] = s.read(coreAbi, r.core, 'disputes', [coreId]);
  const period = periods[periodId];
  requireThat(period && arbitrated === r.adapter && ruled === finalised, 'Core/adapter dispute or finality mismatch.');
  requireThat(finalised ? period === 'execution' && adapterRuling >= 2n && adapterRuling <= 4n : adapterRuling === 0n,
    'Unexpected adapter ruling.');
  if (state > 2) requireThat(finalised && recordedRuling === adapterRuling &&
    challengeState === outcomes[Number(adapterRuling - 2n)], 'Resolved Agreement outcome differs from adapter ruling.');
  const ids = { actionId: actionId.toString(), challengeId: r.challengeId.toString(), agreementDisputeId: adapterId.toString(),
    coreDisputeId: coreId.toString(), courtId: courtId.toString(), roundId: r.roundId.toString(), app, appActionId: appActionId.toString() };
  return { ids, coreId, courtId, adapterId, period, periodId, lastChange, finalised, adapterRuling,
    challengeState, recordedRuling, closed, collateralId,
    caseContext: { settingId: settingId.toString(), submitter, challenger, actionContext, challengeContext } };
}

export function planDispute(s: Snapshot, r: DisputeCommand) {
  const c = readCase(s, r);
  const { ids, coreId, period } = c;
  const rounds = s.read(coreAbi, r.core, 'getNumberOfRounds', [coreId]);
  requireThat(rounds > 0n && r.roundId === rounds - 1n, 'Requested round is not current.');
  const round = s.read(coreAbi, r.core, 'getRoundInfo', [coreId, r.roundId]);
  requireThat(round.feeToken === r.honey, 'Round fees must be denominated in the expected Honey token.');
  requireThat(round.disputeKitID === 1n && s.read(coreAbi, r.core, 'disputeKits', [1n]) === r.classic &&
    s.read(classicAbi, r.classic, 'core', []) === r.core, 'Current round is not bound to the expected Classic kit.');
  const [known, current] = s.read(classicAbi, r.classic, 'coreDisputeIDToActive', [coreId]);
  requireThat(known && current, 'Dispute is inactive in Classic.');
  const drawn = BigInt(round.drawnJurors.length);
  requireThat((period === 'evidence' ? drawn <= round.nbVotes : drawn === round.nbVotes) &&
    round.drawnJurorFromCourtIDs.length === round.drawnJurors.length,
    'Inconsistent round draw data.');
  const { hiddenVotes, timesPerPeriod } = s.read(coreAbi, r.core, 'getAdditionalCourtParams', [c.courtId, round.courtParamsIndex]);
  const summary = { ids, period, hiddenVotes, roundFeeRaw: round.totalFeesForJurors.toString(),
    honeyAtStakePerSeatRaw: round.pnkAtStakePerJuror.toString() };
  if (r.command === 'my-votes' || r.command === 'vote') {
    const seat = (id: bigint) => {
      requireThat(id < drawn && round.drawnJurors[Number(id)] === r.from, 'Vote ID is not assigned to the requesting wallet.');
      const [account, , choice, voted] = s.read(classicAbi, r.classic, 'getVoteInfo', [coreId, r.roundId, id]);
      requireThat(account === r.from, 'Classic vote owner differs from Core assignment.');
      return { voteId: id.toString(), voted, choice: voted ? choice.toString() : null };
    };
    if (r.command === 'my-votes') {
      const seats = round.drawnJurors.flatMap((wallet, i) => wallet === r.from ? [seat(BigInt(i))] : []);
      return { ...summary, juror: r.from, seats, caseContext: c.caseContext };
    }
    requireThat(!hiddenVotes, 'Hidden voting requires commit/reveal, which is unsupported.');
    requireThat(period === 'vote' && !s.read(coreAbi, r.core, 'arbitrationPaused', []), 'Voting requires an unpaused vote period.');
    requireThat(r.voteIds.every(id => !seat(id).voted), 'One or more requested votes have already been cast.');
    return { ...summary, preview: preview(r, 'DisputeKitClassic', r.classic, classicAbi, 'castVote',
      [coreId, r.voteIds, choices[r.choice], 0n, r.justification],
      `Cast the juror’s explicit public choice "${r.choice}" for seats ${r.voteIds.join(', ')}. Classic chooses the current round on execution. The justification is public. Incoherent votes risk Honey penalties.`) };
  }
  switch (r.command) {
    case 'draw': {
      requireThat(period === 'evidence' && !s.read(coreAbi, r.core, 'arbitrationPaused', []), 'Draw requires unpaused evidence period.');
      const module = sortitionAddress(s, r);
      requireThat(s.read(sortitionAbi, module, 'phase', []) === 2 && drawn < round.nbVotes, 'Draw requires drawing phase with unfilled seats.');
      return { ...summary, preview: preview(r, 'KlerosCore', r.core, coreAbi, 'draw', [coreId, r.iterations],
        `Attempt up to ${r.iterations} draws. A draw can skip an ineligible wallet. Inspect the resulting seats before advancing.`) };
    }
    case 'pass-period': {
      requireThat(!hiddenVotes, 'Hidden-vote period workflow is unsupported.');
      const now = BigInt(s.block.timestamp);
      requireThat(!s.read(coreAbi, r.core, 'arbitrationPaused', []) && now > s.read(coreAbi, r.core, 'arbitrationPauseGracePeriodEnd', []),
        'Period transitions are paused or in the arbitration grace period.');
      requireThat(period === r.period, 'Recorded period differs from requested period.');
      const elapsed = now - c.lastChange;
      const duration = timesPerPeriod[c.periodId];
      requireThat(duration !== undefined && elapsed >= 0n, 'Invalid period or timestamp.');
      if (period === 'evidence') {
        requireThat(drawn === round.nbVotes && (r.roundId > 0n || elapsed >= duration), 'Evidence time or drawing is incomplete.');
      } else if (period === 'vote') {
        requireThat(elapsed >= duration || s.read(classicAbi, r.classic, 'areVotesAllCast', [coreId]), 'Voting is still open.');
      } else {
        requireThat(elapsed >= duration || s.read(classicAbi, r.classic, 'isAppealFunded', [coreId]), 'Appeal period is still open.');
      }
      return { ...summary, preview: preview(r, 'KlerosCore', r.core, coreAbi, 'passPeriod', [coreId],
        `Advance the dispute from its recorded ${period} period. Calldata carries only the dispute ID. A later state change can advance a different period.`) };
    }
    case 'execute-rewards': {
      requireThat(period === 'execution' && !s.read(coreAbi, r.core, 'paused', []), 'Reward processing requires execution and unpaused assets.');
      const coherent = s.read(classicAbi, r.classic, 'getCoherentCount', [coreId, r.roundId]);
      const end = coherent === 0n ? drawn : 2n * drawn;
      requireThat(round.repartitions < end, 'Round redistribution complete.');
      requireThat(round.repartitions + r.iterations < 2n ** 256n, 'Reward iteration count would overflow.');
      return { ...summary, remainingIterations: (end - round.repartitions).toString(),
        preview: preview(r, 'KlerosCore', r.core, coreAbi, 'execute', [coreId, r.roundId, r.iterations],
          'Process round penalties and rewards. Ruling delivery is a separate keeper call.') };
    }
    case 'execute-ruling': {
      requireThat(period === 'execution' && !c.finalised && !s.read(coreAbi, r.core, 'arbitrationPaused', []),
        'Ruling delivery requires unpaused arbitration, execution period and an undelivered ruling.');
      const [choice, tied, overridden] = s.read(coreAbi, r.core, 'currentRuling', [coreId]);
      requireThat(choice <= 2n, 'Unexpected Classic ruling for a two-choice Agreement dispute.');
      return { ...summary, coreRuling: choice.toString(), tied, overridden, expectedAgreementRuling: (choice + 2n).toString(),
        preview: preview(r, 'KlerosCore', r.core, coreAbi, 'executeRuling', [coreId],
          'Deliver the Core ruling to the Agreement adapter. Agreement resolution remains a separate call.') };
    }
    case 'settlement':
    case 'resolve': {
      const fees = s.read(agreementAbi, r.agreement, 'getChallengeArbitratorFees', [r.challengeId]);
      const [collateral, , actionRaw, challengeRaw] = s.read(agreementAbi, r.agreement, 'getCollateralRequirement', [ids.app, c.collateralId]);
      const coreRuling = c.finalised ? s.read(coreAbi, r.core, 'currentRuling', [coreId])[0] : null;
      requireThat(coreRuling === null || coreRuling + 2n === c.adapterRuling,
        'The recorded Core ruling differs from the adapter’s final Agreement ruling.');
      const settlement = { ...summary, savedSetting: { id: c.caseContext.settingId, arbitrator: r.adapter }, agreement: r.agreement,
        coreRuling: coreRuling?.toString() ?? null, challengeState: c.challengeState, actionClosed: c.closed,
        adapterFinalised: c.finalised, adapterRuling: c.finalised ? c.adapterRuling.toString() : null,
        appliedAgreementRuling: c.challengeState === 'disputed' ? null : c.recordedRuling.toString(),
        collateralToken: collateral, actionCollateralRaw: actionRaw.toString(), challengeCollateralRaw: challengeRaw.toString(),
        submitterFeeToken: fees[0], submitterFeeRaw: fees[1].toString(), challengerFeeToken: fees[2], challengerFeeRaw: fees[3].toString() };
      if (r.command === 'settlement') return { ...settlement, roundCount: rounds.toString(),
        stage: !c.finalised ? 'before-callback' : c.challengeState === 'disputed' ? 'awaiting-agreement' : 'agreement-resolved' };
      requireThat(fees[0] === r.honey && fees[2] === r.honey && collateral === r.honey,
        'Expected Honey for Agreement collateral and both parties’ dispute fees.');
      requireThat(period === 'execution' && c.finalised && c.challengeState === 'disputed',
        'Resolution requires a delivered ruling and an unresolved disputed challenge.');
      return { ...settlement, preview: preview(r, 'Agreement', r.agreement, agreementResolutionAbi, 'resolve', [c.adapterId],
        `Apply Agreement ruling ${c.adapterRuling} (${outcomes[Number(c.adapterRuling - 2n)]}) to challenge ${r.challengeId}. Agreement settles collateral and invokes the disputable app callback.`) };
    }
  }
}
