import { decodeFunctionData, parseAbi, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { coreAbi, eligibilityAbi, sortitionAbi, strategyAbi } from '../../src/kleros-court/abis.js';
import { base, core, honey, identity, juror, module, operator, other, stakingFixture, strategy } from './fixture.js';

const stake = { ...base, courtId: '1', targetRaw: '100' };
function check(f: ReturnType<typeof stakingFixture>, cmd: string, fields: Record<string, unknown>) {
  const res = f.run(cmd, fields);
  expect(res.error).toBeUndefined();
  if (!res.ok || !res.data || !('preview' in res.data) || !res.data.preview) throw new Error('Expected an unsigned preview.');
  const tx = res.data.preview;
  expect(tx.simulation.status).toBe('not-run');
  expect(tx.policy.checks).toContainEqual(expect.objectContaining({ status: 'fail' }));
  expect(tx.value).toBe('0');
  return tx;
}

describe('juror Honey and sortition operators', () => {
  it('approves exactly the required stake delta to Core, then targets the total, including a queued increase', () => {
    const f = stakingFixture().set(honey, erc20Abi, 'allowance', [juror, core], 0n);
    const approval = check(f, 'approve-stake', stake);
    expect(approval.to).toBe(honey);
    expect(decodeFunctionData({ abi: parseAbi(['function approve(address,uint256)']), data: approval.data }).args).toEqual([core, 59n]);
    expect(f.run('stake', stake).error?.message).toMatch(/allowance/);
    f.set(honey, erc20Abi, 'allowance', [juror, core], 59n);
    expect(f.run('approve-stake', stake).ok).toBe(false);
    const tx = check(f, 'stake', stake);
    expect(tx.to).toBe(core);
    expect(tx.from).toBe(juror);
    expect(decodeFunctionData({ abi: parseAbi(['function setStake(uint96,uint256)']), data: tx.data }).args).toEqual([1n, 100n]);
    for (const phase of [1, 2]) {
      f.set(module, sortitionAbi, 'phase', [], phase);
      expect(f.run('stake', stake).data).toMatchObject({ delivery: 'delayed' });
    }
  });

  it('previews a zero target with outstanding locks and uses the leftover beneficiary for a later payout', () => {
    const f = stakingFixture();
    expect(f.run('stake', { ...stake, targetRaw: '0' }).data).toMatchObject({ totalLockedRaw: '13', preview: { decoded: { args: { newStake: '0' } } } });
    f.set(module, sortitionAbi, 'getJurorLeftoverPNK', [juror], 0n);
    const claim = { ...base, from: operator, beneficiary: juror };
    expect(f.run('withdraw-leftover', claim).ok).toBe(false);
    f.set(module, sortitionAbi, 'getJurorLeftoverPNK', [juror], 13n);
    const withdrawal = check(f, 'withdraw-leftover', claim);
    expect(withdrawal).toMatchObject({ to: module, from: operator, decoded: { args: { account: juror } } });
  });

  it('can queue the recorded target again after another pending change, and refuses an empty exit', () => {
    const f = stakingFixture().set(module, sortitionAbi, 'phase', [], 2);
    expect(f.run('stake', { ...stake, targetRaw: '41' }).data).toMatchObject({ delivery: 'delayed' });
    f.set(module, sortitionAbi, 'getJurorBalance', [juror, 1n], [0n, 0n, 0n, 0n]);
    expect(f.run('stake', { ...stake, targetRaw: '0' }).ok).toBe(false);
  });

  it('only clears an existing allowance and refuses to overwrite a positive allowance', () => {
    const f = stakingFixture().set(honey, erc20Abi, 'allowance', [juror, core], 1n);
    expect(f.run('approve-stake', stake).error?.message).toMatch(/Clear/);
    expect(check(f, 'clear-stake-allowance', base).decoded.args).toEqual({ spender: core, amount: '0' });
    f.set(honey, erc20Abi, 'allowance', [juror, core], 0n);
    expect(f.run('clear-stake-allowance', base).ok).toBe(false);
  });

  it('checks eligibility on a weighted ancestor even when the staking court itself is linear', () => {
    const f = stakingFixture().set(core, coreAbi, 'courts', [3n], [1n, 20n, 1000n, 30n, other])
      .set(module, sortitionAbi, 'getJurorBalance', [juror, 3n], [41n, 13n, 41n, 1n])
      .set(strategy, strategyAbi, 'usesIdentityWeight', [3n], false)
      .set(other, eligibilityAbi, 'isEligible', [juror, 3n], true)
      .set(strategy, strategyAbi, 'identityOf', [juror], operator);
    const r = { ...stake, courtId: '3' };
    expect(f.run('stake', r).error?.message).toMatch(/identity/);
    f.set(strategy, strategyAbi, 'identityOf', [juror], identity);
    expect(f.run('stake', r).ok).toBe(true);
    f.set(other, eligibilityAbi, 'isEligible', [juror, 3n], false);
    expect(f.run('stake', r).error?.message).toMatch(/ineligible/);
    expect(f.run('stake', { ...r, targetRaw: '0' }).ok).toBe(true);
  });

  it('rejects a wrong token or module, paused assets, insufficient capacity, balance, and an absent NFT', () => {
    const samples = [
      stakingFixture().set(core, coreAbi, 'pinakion', [], other),
      stakingFixture().set(module, sortitionAbi, 'core', [], other),
      stakingFixture().set(core, coreAbi, 'paused', [], true),
      stakingFixture().set(core, coreAbi, 'jurorNft', [], other).set(other, erc20Abi, 'balanceOf', [juror], 0n),
      stakingFixture().set(module, sortitionAbi, 'maxStakePerJuror', [], 99n),
      stakingFixture().set(module, sortitionAbi, 'maxTotalStaked', [], 758n),
      stakingFixture().set(honey, erc20Abi, 'balanceOf', [juror], 58n),
      stakingFixture().set(module, sortitionAbi, 'getJurorBalance', [juror, 1n], [41n, 13n, 0n, 4n]),
      stakingFixture().set(strategy, strategyAbi, 'identityOf', [juror], zeroAddress)
    ];
    for (const f of samples) expect(f.run('stake', stake).ok).toBe(false);
    expect(stakingFixture().run('stake', { ...stake, targetRaw: '19' }).ok).toBe(false);
  });

  it('checks global phase, pending draws and timeout and leaves RNG readiness conditional', () => {
    const f = stakingFixture().set(module, sortitionAbi, 'lastPhaseChange', [], 100n)
      .set(module, sortitionAbi, 'minStakingTime', [], 50n)
      .set(module, sortitionAbi, 'maxDrawingTime', [], 50n)
      .set(module, sortitionAbi, 'disputesWithoutJurors', [], 1n);
    const phase = (p: string) => f.run('pass-phase', { ...base, from: operator, phase: p });
    f.timestamp = '149';
    expect(phase('staking').ok).toBe(false);
    f.timestamp = '150';
    expect(phase('staking').data).toMatchObject({ preview: { to: module, from: operator, decoded: { method: 'passPhase' } } });
    f.set(module, sortitionAbi, 'disputesWithoutJurors', [], 0n);
    expect(phase('staking').ok).toBe(false);
    f.set(module, sortitionAbi, 'phase', [], 1);
    expect(phase('staking').ok).toBe(false);
    expect(phase('generating').data).toMatchObject({ preview: { decoded: { humanSummary: expect.stringContaining('RNG readiness is unverified') } } });
    f.set(module, sortitionAbi, 'rng', [], zeroAddress);
    expect(phase('generating').ok).toBe(false);
    f.set(module, sortitionAbi, 'phase', [], 2);
    f.timestamp = '149';
    expect(phase('drawing').ok).toBe(true);
    f.set(module, sortitionAbi, 'disputesWithoutJurors', [], 1n);
    expect(phase('drawing').ok).toBe(false);
    f.timestamp = '150';
    expect(phase('drawing').ok).toBe(true);
  });

  it('processes a nonempty delayed queue in staking phase, including the last queued entry', () => {
    const f = stakingFixture().set(module, sortitionAbi, 'delayedStakeReadIndex', [], 7n)
      .set(module, sortitionAbi, 'delayedStakeWriteIndex', [], 7n);
    const r = { ...base, from: operator, iterations: '1' };
    expect(check(f, 'execute-delayed-stakes', r).decoded).toMatchObject({ method: 'executeDelayedStakes', args: { iterations: '1' } });
    f.set(module, sortitionAbi, 'phase', [], 2);
    expect(f.run('execute-delayed-stakes', r).ok).toBe(false);
    f.set(module, sortitionAbi, 'phase', [], 0).set(module, sortitionAbi, 'delayedStakeReadIndex', [], 8n);
    expect(f.run('execute-delayed-stakes', r).ok).toBe(false);
  });
});
