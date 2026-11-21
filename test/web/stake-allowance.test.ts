import { decodeFunctionData, encodeFunctionResult, type Hex } from 'viem';
import { expect, it, vi } from 'vitest';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { TOKENS } from '../../src/onehive/addresses.js';
import { queryStakeAllowance } from '../../src/web/stake-allowance.js';
import type { StakeDeps } from '../../src/web/stake.js';
import { actor, core, fixture, profile } from '../../examples/governance/fixture.js';

const p: typeof profile = { ...profile, stake: { core, courtId: '1' } };
const hash = ('0x' + 'a5'.repeat(32)) as Hex;
const increase = { account: actor, mode: 'increase', target: '60.000000000000000001', blockHash: hash } as const;
const clear = { account: actor, mode: 'clear', blockHash: hash } as const;
const delta = 10n ** 19n + 1n;

function setup(allowance: bigint, approval = true) {
  const stake = fixture({ stakePhase: 0 }).stake!;
  const call = vi.fn<StakeDeps['call']>(async (tx, block) => {
    expect(block).toBe(hash);
    if (tx.to === TOKENS.HNY) {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      if (decoded.functionName === 'allowance') {
        expect(decoded.args).toEqual([actor, core]);
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'allowance', result: allowance });
      }
      if (decoded.functionName === 'approve') {
        expect(tx.from).toBe(actor);
        expect(decoded.args).toEqual([core, allowance ? 0n : delta]);
        return encodeFunctionResult({ abi: erc20Abi, functionName: 'approve', result: approval });
      }
    }
    expect(tx.from).toBeUndefined();
    return stake.call(tx, block);
  });
  return { ...stake, call };
}

it.each([[increase, 0n, delta], [clear, 1n, 0n]] as const)('simulates exact approval and projects only public review fields', async (input, allowance, amount) => {
  const rpc = setup(allowance);
  const result = await queryStakeAllowance(p, input, rpc);
  expect(result).toMatchObject({ mode: input.mode, spender: core, approvalRaw: String(amount), allowanceRaw: String(allowance), submitted: false });
  expect(JSON.stringify(result)).not.toMatch(/"data"|"preview"|"signature"/);
  expect(rpc.call.mock.calls.filter(([tx]) => tx.from)).toHaveLength(1);
});

it.each([[increase, 1n], [increase, delta], [clear, 0n], [{ ...increase, target: '50' }, 0n], [{ ...increase, target: '150' }, 0n]] as const)(
  'does not simulate if the stake planner rejects', async (input, existing) => {
    const rpc = setup(existing);
    await expect(queryStakeAllowance(p, input, rpc)).rejects.toMatchObject({ code: 'stake-not-ready' });
    expect(rpc.call.mock.calls.some(([tx]) => tx.from)).toBe(false);
  });

it('fails closed on false token return, remote profile, or changed snapshot', async () => {
  await expect(queryStakeAllowance(p, clear, setup(1n, false))).rejects.toMatchObject({ code: 'simulation' });
  const rpc = setup(1n);
  await expect(queryStakeAllowance({ ...p, jurySimulation: false }, clear, rpc)).rejects.toMatchObject({ code: 'stake-not-ready' });
  await expect(queryStakeAllowance(p, { ...clear, blockHash: '0x' + 'dd'.repeat(32) }, rpc)).rejects.toMatchObject({ code: 'stake-stale' });
  expect(rpc.call).not.toHaveBeenCalled();
});
