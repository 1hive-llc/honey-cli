import { expect, it } from 'vitest';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { classicAbi, coreAbi, sortitionAbi } from '../../src/kleros-court/abis.js';
import { agreement, agreementId, base, caseFixture, caseRequest, classic, core, honey, juror, module,
  operator, other, stakingFixture } from './fixture.js';

// Hand-recorded checkpoints in the public-vote path of AgreementIntegration.t.sol.
// Each step plans exactly one call. No state transition or choice is performed by the runner.
it('follows Core case zero from a juror stake through an independently observed Agreement settlement', () => {
  const r = { ...base, courtId: '1', targetRaw: '100' };
  const stake = stakingFixture().set(honey, erc20Abi, 'allowance', [juror, core], 0n);
  expect(stake.run('approve-stake', r).data).toMatchObject({ preview: { to: honey, decoded: { args: { amount: '59' } } } });
  stake.set(honey, erc20Abi, 'allowance', [juror, core], 59n);
  expect(stake.run('stake', r).data).toMatchObject({ preview: { to: core, decoded: { args: { newStake: '100' } } } });

  const globalOperator = { ...base, from: operator };
  stake.set(module, sortitionAbi, 'lastPhaseChange', [], 100n).set(module, sortitionAbi, 'minStakingTime', [], 50n)
    .set(module, sortitionAbi, 'disputesWithoutJurors', [], 1n);
  expect(stake.run('pass-phase', { ...globalOperator, phase: 'staking' }).ok).toBe(true);
  stake.set(module, sortitionAbi, 'phase', [], 1);
  expect(stake.run('pass-phase', { ...globalOperator, phase: 'generating' }).ok).toBe(true);

  const keeper = { ...caseRequest, from: operator };
  const beforeDraw = caseFixture({ id: 0n, period: 0, drawn: [] });
  expect(beforeDraw.run('draw', { ...keeper, iterations: '3' }).data).toMatchObject({
    ids: { coreDisputeId: '0', challengeId: '18', agreementDisputeId: agreementId(0n).toString() },
    preview: { from: operator, to: core }
  });
  const drawn = caseFixture({ id: 0n, period: 0 });
  expect(drawn.run('pass-period', { ...keeper, period: 'evidence' }).ok).toBe(true);
  const voting = caseFixture({ id: 0n });
  expect(voting.run('my-votes', caseRequest).data).toMatchObject({ seats: [{ voteId: '0' }, { voteId: '2' }] });
  const firstVote = { ...caseRequest, voteIds: ['0', '2'], choice: 'submitter', justification: 'Fixture evidence A.' };
  expect(voting.run('vote', firstVote).data).toMatchObject({ preview: { from: juror, to: classic, decoded: { args: { choice: '2' } } } });
  expect(voting.run('vote', { ...firstVote, from: operator }).ok).toBe(false);
  const secondVote = { ...caseRequest, from: other, voteIds: ['1'], choice: 'challenger', justification: 'Fixture evidence B.' };
  expect(voting.run('vote', secondVote).data).toMatchObject({ preview: { from: other, to: classic, decoded: { args: { choice: '1' } } } });
  voting.timestamp = '101';
  voting.set(classic, classicAbi, 'areVotesAllCast', [0n], true);
  expect(voting.run('pass-period', { ...keeper, period: 'vote' }).ok).toBe(true);
  expect(caseFixture({ id: 0n, period: 3 }).run('pass-period', { ...keeper, period: 'appeal' }).ok).toBe(true);

  const execution = caseFixture({ id: 0n, period: 4 }).set(core, coreAbi, 'currentRuling', [0n], [2n, false, false]);
  const ruling = execution.run('execute-ruling', keeper);
  expect(ruling.data).toMatchObject({ coreRuling: '2', preview: { to: core, decoded: { args: { disputeID: '0' } } } });
  expect(execution.run('resolve', keeper).ok).toBe(false);
  const delivered = caseFixture({ id: 0n, period: 4, finalised: true, ruling: 4n });
  expect(delivered.run('execute-rewards', { ...keeper, iterations: '6' }).ok).toBe(true);
  expect(delivered.run('resolve', keeper).data).toMatchObject({ appliedAgreementRuling: null,
    preview: { to: agreement, decoded: { args: { disputeId: agreementId(0n).toString() } } } });
  expect(caseFixture({ id: 0n, period: 4, finalised: true, ruling: 4n, state: 3 }).run('settlement', keeper).data)
    .toMatchObject({ adapterRuling: '4', appliedAgreementRuling: '4', challengeState: 'accepted' });
});
