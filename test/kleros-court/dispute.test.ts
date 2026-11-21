import { decodeFunctionData, parseAbi, zeroAddress, zeroHash } from 'viem';
import { describe, expect, it } from 'vitest';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { adapterAbi, classicAbi, coreAbi, sortitionAbi } from '../../src/kleros-court/abis.js';
import { adapter, agreement, agreementId, app, caseFixture, caseRequest, classic, core, coreId, honey, juror,
  module, operator, other, submitter } from './fixture.js';

const keeper = { ...caseRequest, from: operator };
const voteRequest = { ...caseRequest, voteIds: ['2', '0'], choice: 'challenger', justification: 'See public evidence B.' };

describe('open Classic round in an Agreement challenge', () => {
  it('draws from Core as the keeper and locates the assigned wallet’s individual seats', () => {
    const f = caseFixture({ period: 0, drawn: [juror] });
    expect(f.run('draw', { ...keeper, iterations: '2' }).data).toMatchObject({
      preview: { from: operator, to: core, decoded: { method: 'draw', args: { disputeID: coreId.toString(), iterations: '2' } } }
    });
    expect(f.run('pass-period', { ...keeper, period: 'evidence' }).error?.message).toMatch(/drawing/);
    f.set(module, sortitionAbi, 'phase', [], 1);
    expect(f.run('draw', { ...keeper, iterations: '2' }).ok).toBe(false);
    const full = caseFixture({ period: 0 });
    expect(full.run('draw', { ...keeper, iterations: '2' }).ok).toBe(false);
    expect(full.run('my-votes', caseRequest).data).toMatchObject({ seats: [
      { voteId: '0', voted: false, choice: null }, { voteId: '2', voted: false, choice: null }
    ] });
    expect(full.run('my-votes', keeper).data).toMatchObject({ seats: [] });
  });

  it('uses caller-selected seats, choice and public rationale; encodes core ID and zero public salt exactly', () => {
    const f = caseFixture();
    const result = f.run('vote', voteRequest);
    expect(result.error).toBeUndefined();
    expect(result.data).toMatchObject({ block: { chainId: 31337, blockNumber: '450' },
      ids: { coreDisputeId: coreId.toString(), agreementDisputeId: agreementId(coreId).toString(), actionId: '11', challengeId: '18' },
      preview: { from: juror, to: classic, value: '0', simulation: { status: 'not-run' } } });
    if (!result.data || !('preview' in result.data) || !result.data.preview) throw new Error('Missing vote preview.');
    const expected = parseAbi(['function castVote(uint256,uint256[],uint256,uint256,string)']);
    expect(decodeFunctionData({ abi: expected, data: result.data.preview.data }).args)
      .toEqual([coreId, [2n, 0n], 1n, 0n, 'See public evidence B.']);
    expect(f.run('vote', voteRequest)).toEqual(result);
    expect(f.run('vote', { ...voteRequest, choice: undefined }).ok).toBe(false);
    expect(f.run('vote', { ...voteRequest, from: operator }).ok).toBe(false);
    expect(f.run('vote', { ...voteRequest, voteIds: ['1'] }).ok).toBe(false);
    expect(f.run('vote', { ...voteRequest, voteIds: ['0', '0'] }).ok).toBe(false);
    expect(f.run('vote', { ...voteRequest, voteIds: [] }).ok).toBe(false);
    expect(f.run('vote', { ...voteRequest, voteIds: [coreId.toString()] }).ok).toBe(false);
  });

  it('checks Classic seat ownership, replay, hidden voting, period, and round before returning calldata', () => {
    const f = caseFixture().set(classic, classicAbi, 'getVoteInfo', [coreId, 0n, 2n], [juror, zeroHash, 2n, true]);
    expect(f.run('vote', voteRequest).error?.message).toMatch(/already/);
    expect(f.run('my-votes', caseRequest).data).toMatchObject({ seats: [{ voteId: '0' }, { voteId: '2', voted: true, choice: '2' }] });
    f.set(classic, classicAbi, 'getVoteInfo', [coreId, 0n, 2n], [other, zeroHash, 0n, false]);
    expect(f.run('vote', voteRequest).error?.message).toMatch(/owner/);
    expect(caseFixture({ hidden: true }).run('vote', voteRequest).error?.message).toMatch(/commit\/reveal/);
    expect(caseFixture({ period: 1 }).run('vote', voteRequest).ok).toBe(false);
    expect(caseFixture({ roundId: 1n }).run('vote', voteRequest).error?.message).toMatch(/round/);
    expect(caseFixture().set(core, coreAbi, 'arbitrationPaused', [], true).run('vote', voteRequest).ok).toBe(false);
  });

  it('applies exact evidence, vote, appeal and grace-period boundaries and checks expected current period', () => {
    for (const [code, period, earlyMethod] of [[0, 'evidence', null], [2, 'vote', 'areVotesAllCast'], [3, 'appeal', 'isAppealFunded']] as const) {
      const f = caseFixture({ period: code });
      const r = { ...keeper, period };
      expect(f.run('pass-period', r).data).toMatchObject({ preview: { to: core, from: operator, decoded: { method: 'passPeriod' } } });
      f.timestamp = '149';
      if (earlyMethod) f.set(classic, classicAbi, earlyMethod, [coreId], false);
      expect(f.run('pass-period', r).ok).toBe(false);
      if (earlyMethod) {
        f.set(classic, classicAbi, earlyMethod, [coreId], true);
        expect(f.run('pass-period', r).ok).toBe(true);
      }
      f.timestamp = '150';
      f.set(core, coreAbi, 'arbitrationPauseGracePeriodEnd', [], 150n);
      expect(f.run('pass-period', r).ok).toBe(false);
    }
    expect(caseFixture().run('pass-period', { ...keeper, period: 'appeal' }).ok).toBe(false);
  });

  it('runs bounded redistribution separately and can deliver a ruling before any rewards have been processed', () => {
    const f = caseFixture({ period: 4, repartitions: 2n });
    expect(f.run('execute-rewards', { ...keeper, iterations: '2' }).data).toMatchObject({
      remainingIterations: '4', preview: { to: core, decoded: { method: 'execute', args: { round: '0', iterations: '2' } } }
    });
    f.set(classic, classicAbi, 'getCoherentCount', [coreId, 0n], 0n);
    expect(f.run('execute-rewards', { ...keeper, iterations: '1' }).data).toMatchObject({ remainingIterations: '1' });
    expect(caseFixture({ period: 4, repartitions: 6n }).run('execute-rewards', { ...keeper, iterations: '2' }).ok).toBe(false);
    f.set(core, coreAbi, 'paused', [], true);
    expect(f.run('execute-rewards', { ...keeper, iterations: '1' }).ok).toBe(false);
    const unprocessed = caseFixture({ period: 4, id: 0n }).set(core, coreAbi, 'currentRuling', [0n], [0n, true, false]);
    expect(unprocessed.run('execute-ruling', keeper).data).toMatchObject({
      coreRuling: '0', tied: true, expectedAgreementRuling: '2', preview: { to: core, decoded: { args: { disputeID: '0' } } }
    });
    expect(unprocessed.run('resolve', keeper).error?.message).toMatch(/delivered/);
    expect(caseFixture({ period: 3 }).run('execute-ruling', keeper).ok).toBe(false);
    expect(caseFixture({ period: 4, finalised: true, ruling: 3n }).run('execute-ruling', keeper).ok).toBe(false);
  });

  it.each([[2n, 5, 'voided'], [3n, 4, 'rejected'], [4n, 3, 'accepted']] as const)(
    'resolves final Agreement ruling %s and distinguishes it from the applied %s state', (ruling, state, label) => {
      const f = caseFixture({ period: 4, finalised: true, ruling });
      const res = f.run('resolve', keeper);
      expect(res.error).toBeUndefined();
      expect(res.data).toMatchObject({ challengeState: 'disputed', adapterFinalised: true, adapterRuling: ruling.toString(), appliedAgreementRuling: null,
        actionCollateralRaw: '100', challengeCollateralRaw: '200', submitterFeeRaw: '75', challengerFeeRaw: '67',
        preview: { from: operator, to: agreement, value: '0', decoded: { method: 'resolve' } } });
      if (!res.data || !('preview' in res.data) || !res.data.preview) throw new Error('Missing resolve preview.');
      expect(decodeFunctionData({ abi: parseAbi(['function resolve(uint256)']), data: res.data.preview.data }).args).toEqual([agreementId(coreId)]);
      const settled = caseFixture({ period: 4, finalised: true, ruling, state });
      expect(settled.run('resolve', keeper).error?.message).toMatch(/unresolved/);
      expect(settled.run('settlement', keeper).data).toMatchObject({ challengeState: label, appliedAgreementRuling: ruling.toString(), actionClosed: state === 4 });
    }
  );

  it('rejects broken links, wrong kit or fee token, unknown adapter IDs and disagreement on finality', () => {
    const aid = agreementId(coreId);
    const samples = [
      caseFixture().set(adapter, adapterAbi, 'core', [], other),
      caseFixture().set(adapter, adapterAbi, 'agreement', [], other),
      caseFixture().set(adapter, adapterAbi, 'honey', [], other),
      caseFixture().set(adapter, adapterAbi, 'agreementDisputeByCore', [coreId], aid + 1n),
      caseFixture().set(adapter, adapterAbi, 'disputes', [aid], [coreId, 0n, false, false]),
      caseFixture().set(adapter, adapterAbi, 'disputes', [aid], [coreId + 1n, 0n, true, false]),
      caseFixture().set(core, coreAbi, 'disputes', [coreId], [1n, other, 2, false, 100n]),
      caseFixture().set(core, coreAbi, 'disputes', [coreId], [1n, adapter, 2, true, 100n]),
      caseFixture().set(core, coreAbi, 'disputeKits', [1n], other),
      caseFixture().set(classic, classicAbi, 'coreDisputeIDToActive', [coreId], [true, false]),
      caseFixture().set(agreement, agreementAbi, 'getAction', [11n], [app, 777n, 8n, 5n, submitter, false, '0x', 17n, true]),
      caseFixture({ kitId: 7n }), caseFixture({ feeToken: zeroAddress }), caseFixture({ state: 0 })
    ];
    for (const f of samples) expect(f.run('vote', voteRequest).ok).toBe(false);
    const wrongFees = caseFixture({ period: 4, finalised: true, ruling: 3n })
      .set(agreement, agreementAbi, 'getChallengeArbitratorFees', [18n], [honey, 75n, other, 67n]);
    expect(wrongFees.run('resolve', keeper).ok).toBe(false);
    expect(caseFixture({ period: 4, finalised: true, ruling: 4n, state: 4 }).run('settlement', keeper).ok).toBe(false);
  });
});
