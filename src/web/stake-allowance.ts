import { encodeFunctionData, encodeFunctionResult, type Address } from 'viem';
import { commands } from '../kleros-court/commands.js';
import { planCourtCommand } from '../kleros-court/run.js';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { TOKENS } from '../onehive/addresses.js';
import { QueryFailure, type Profile } from './profile.js';
import { stakeTargetRaw, withStakeSnapshot, type StakeDeps } from './stake.js';

export type StakeAllowancePreview = { account: Address; blockHash: string } &
  ({ mode: 'increase'; target: string } | { mode: 'clear' });

export function queryStakeAllowance(p: Profile, input: StakeAllowancePreview, rpc: StakeDeps) {
  return withStakeSnapshot(p, input, rpc, async (current, s, core, courtId, account, hash) => {
    const target = input.mode === 'increase' ? stakeTargetRaw(input.target) : 0n;
    const base = { chainId: p.chainId, core, honey: TOKENS.HNY, from: account };
    const request = commands.parse(input.mode === 'increase'
      ? { ...base, command: 'approve-stake', courtId, targetRaw: String(target) }
      : { ...base, command: 'clear-stake-allowance' });
    const plan = planCourtCommand(request, s).data;
    const amount = input.mode === 'increase' ? target - BigInt(current.currentStakeRaw) : 0n;
    if (!plan || !('preview' in plan) || !plan.preview || plan.preview.to !== TOKENS.HNY ||
        plan.preview.data !== encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [core, amount] })) {
      throw new QueryFailure('stake-not-ready');
    }
    try {
      const result = await rpc.call({ to: TOKENS.HNY, from: account, data: plan.preview.data }, hash);
      if (result !== encodeFunctionResult({ abi: erc20Abi, functionName: 'approve', result: true })) throw new Error();
    } catch { throw new QueryFailure('simulation'); }
    return { ...current, mode: input.mode, spender: core, approvalRaw: String(amount), submitted: false };
  });
}
