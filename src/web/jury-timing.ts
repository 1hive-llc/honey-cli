import { parseAbi } from 'viem';
import { classicAbi, coreAbi } from '../kleros-court/abis.js';
import type { ChainClient } from '../onehive/clients/chain.js';
import type { observeJury } from './jury.js';

// Candidate DisputeKitClassic.sol (sha256 f1e35eef…), also checked against its compiled ABI.
const extraKit = parseAbi([
  'function areCommitsAllCast(uint256) view returns (bool)',
  'function getFundedChoices(uint256) view returns (uint256[])'
]);
const periods = ['evidence', 'commit', 'vote', 'appeal', 'execution'];
type View = Awaited<ReturnType<typeof observeJury>>;
export type JuryTiming = {
  status: 'available' | 'unavailable'; timeThreshold: string | null; transition: string; fundedChoices: string[] | null;
};

// Call with the same block-pinned client used for observeJury. No wall-clock estimates.
export async function readJuryTiming(client: ChainClient, v: View, blockTimestamp?: bigint): Promise<JuryTiming> {
  const result: JuryTiming = { status: 'unavailable', timeThreshold: null, transition: 'Timing unavailable.', fundedChoices: null };
  try {
    const { period, paused, kitActive, roundId } = v.jury;
    const index = periods.indexOf(period);
    if (!kitActive || index < 0) return result;
    if (period === 'execution') return { ...result, status: 'available', transition: 'Final period; no further period transition.' };
    const [court, , phase, , start] = await client.readContract<[bigint, string, number, boolean, bigint]>({
      address: v.core, abi: coreAbi, functionName: 'disputes', args: [v.coreId] });
    if (court !== BigInt(v.courtId) || phase !== index || typeof start !== 'bigint' || (blockTimestamp !== undefined && start > blockTimestamp)) return result;
    const threshold = start + (period === 'evidence' && roundId !== '0' ? 0n : v.timesPerPeriod[index]!);
    const kitRead = <T>(functionName: string, abi: typeof classicAbi | typeof extraKit) =>
      client.readContract<T>({ address: v.kit, abi, functionName, args: [v.coreId] });
    if (period === 'appeal') {
      const choices = await kitRead<bigint[]>('getFundedChoices', extraKit).catch(() => null);
      if (choices && choices.length <= 3 && new Set(choices).size === choices.length && choices.every(c => typeof c === 'bigint' && c >= 0n && c <= 2n))
        result.fundedChoices = choices.map(String);
    }
    result.timeThreshold = String(threshold);
    result.status = 'available';
    if (paused) result.transition = 'Arbitration paused.';
    else if (period === 'evidence' && !v.drawn) result.transition = 'Waiting for all jurors to be drawn.';
    else if (blockTimestamp === undefined) result.transition = 'Block time unavailable; eligibility unknown.';
    else {
      const grace = await client.readContract<bigint>({ address: v.core, abi: coreAbi, functionName: 'arbitrationPauseGracePeriodEnd' });
      if (typeof grace !== 'bigint') throw Error();
      if (blockTimestamp <= grace) result.transition = 'Pause grace period still active.';
      else if (blockTimestamp >= threshold) result.transition = 'Eligible for transition: time threshold reached.';
      else if (period === 'evidence') result.transition = 'Waiting for the evidence time threshold.';
      else {
        // isAppealFunded is the core's early-exit predicate, NOT a funding-status getter.
        const early = period === 'appeal' ? await kitRead<boolean>('isAppealFunded', classicAbi) :
          period === 'commit' ? await kitRead<boolean>('areCommitsAllCast', extraKit) : await kitRead<boolean>('areVotesAllCast', classicAbi);
        if (typeof early !== 'boolean') throw Error();
        result.transition = !early ? 'Time threshold and early-transition condition not met.' :
          period === 'appeal' ? 'Eligible for transition: early appeal-close condition met.' :
          period === 'commit' ? 'Eligible for transition: all commits cast.' : 'Eligible for transition: all required votes cast.';
      }
    }
  } catch { result.transition = 'Transition eligibility unavailable.'; }
  return result;
}
