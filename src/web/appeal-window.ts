import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, keccak256,
  maxUint256, parseAbi, zeroAddress, type Abi, type Address, type ContractFunctionArgs, type ContractFunctionName,
  type ContractFunctionReturnType } from 'viem';
import { adapterAbi, classicAbi, coreAbi } from '../kleros-court/abis.js';
import { agreementAbi, agreementResolutionAbi } from '../onehive/abis/agreement.js';
import { convictionVotingAbi } from '../onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../onehive/abis/disputableVoting.js';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { ONEHIVE, TOKENS } from '../onehive/addresses.js';
import { QueryFailure, validId, type Kind, type Profile } from './profile.js';
import type { StakeDeps } from './stake.js';

// Candidate Core 0d9246da / Classic f1e35eef. No contribution, withdrawal or other write selectors.
export const appealReadAbi = parseAbi([
  'function appealPeriod(uint256) view returns (uint256,uint256)',
  'function getFundedChoices(uint256) view returns (uint256[])',
  'function WINNER_STAKE_MULTIPLIER() view returns (uint256)',
  'function LOSER_STAKE_MULTIPLIER() view returns (uint256)',
  'function LOSER_APPEAL_PERIOD_MULTIPLIER() view returns (uint256)',
  'function getDisputeFeeToken(uint256) view returns (address)',
  'function appealCostInFeeToken(uint256) view returns (uint256)',
  'function getCourtAndDisputeKitJumps(uint256) view returns (uint96,uint256,uint256,bool,bool)'
]);
export type AppealWindowInput = { kind: Kind; id: string };
const unavailable = () => new QueryFailure('appeal-not-ready');

export async function queryAppealWindow(p: Profile, input: AppealWindowInput, rpc: StakeDeps) {
  if (!p.adapter || !validId(input.id) || !['votes','proposals'].includes(input.kind) || await rpc.chain() !== p.chainId) throw unavailable();
  const { hash, number, timestamp } = await rpc.block();
  if (!hash || number === null) throw unavailable();
  async function read<const A extends Abi, F extends ContractFunctionName<A,'view'>>(to: Address, abi: A, fn: F,
    ...args: ContractFunctionArgs<A,'view',F> & readonly unknown[]) {
    try {
      const binding = { abi: abi as Abi, functionName: fn as string };
      const bytes = await rpc.call({ to, data: encodeFunctionData({ ...binding, args }) }, hash!);
      const result = decodeFunctionResult({ ...binding, data: bytes });
      if (encodeFunctionResult({ ...binding, result }).toLowerCase() !== bytes.toLowerCase()) throw unavailable();
      return result as ContractFunctionReturnType<A,'view',F>;
    } catch { throw unavailable(); }
  }
  const adapter = getAddress(p.adapter), agreement = getAddress(p.env.ONEHIVE_AGREEMENT || ONEHIVE.AGREEMENT);
  const cv = input.kind === 'proposals', id = BigInt(input.id);
  const app = getAddress(cv ? p.env.ONEHIVE_CONVICTION_VOTING || ONEHIVE.CONVICTION_VOTING :
    p.env.ONEHIVE_DISPUTABLE_VOTING || ONEHIVE.DISPUTABLE_VOTING);
  const action = cv ? (await read(app, convictionVotingAbi, 'getProposal', id))[6] : (await read(app, disputableVotingAbi, 'getVote', id))[7];
  if (!action) throw unavailable();
  const [linkedApp, local, , setting, , closed, , challenge, active] = await read(agreement, agreementAbi, 'getAction', action);
  if (linkedApp !== app || local !== id || closed || !active || !challenge ||
      (await read(agreement, agreementResolutionAbi, 'getSetting', setting))[0] !== adapter) throw unavailable();
  const [linkedAction, , , , , state, , , dispute, ruling] = await read(agreement, agreementAbi, 'getChallenge', challenge);
  if (linkedAction !== action || state !== 2 || ruling !== 0n) throw unavailable();
  const [bound, core, honey, [coreId, adapterChoice, exists, final]] = await Promise.all([read(adapter, adapterAbi, 'agreement'),
    read(adapter, adapterAbi, 'core'), read(adapter, adapterAbi, 'honey'), read(adapter, adapterAbi, 'disputes', dispute)]);
  if (bound !== agreement || core === zeroAddress || (p.stake && p.stake.core !== core) || honey !== TOKENS.HNY || !exists || final ||
      adapterChoice !== 0n || BigInt(keccak256(encodeAbiParameters([{ type:'address' },{ type:'uint256' }], [adapter,coreId]))) !== dispute) throw unavailable();
  const [reverse, [court, arbitrated, period, ruled], token, count] = await Promise.all([
    read(adapter, adapterAbi, 'agreementDisputeByCore', coreId), read(core, coreAbi, 'disputes', coreId),
    read(core, coreAbi, 'pinakion'), read(core, coreAbi, 'getNumberOfRounds', coreId)]);
  if (reverse !== dispute || arbitrated !== adapter || period !== 3 || ruled || token !== honey || !count || !court) throw unavailable();
  const roundId = count - 1n, round = await read(core, coreAbi, 'getRoundInfo', coreId, roundId);
  if (round.disputeKitID !== 1n) throw unavailable();
  const kit = await read(core, coreAbi, 'disputeKits', 1n);
  if (kit === zeroAddress || await read(kit, classicAbi, 'core') !== core ||
      !(await read(kit, classicAbi, 'coreDisputeIDToActive', coreId)).every(Boolean)) throw unavailable();
  const [[start,end], [choice,tied,overridden], funded, paused] = await Promise.all([read(core, appealReadAbi,'appealPeriod',coreId),
    read(core, coreAbi,'currentRuling',coreId), read(kit,appealReadAbi,'getFundedChoices',coreId), read(core,coreAbi,'arbitrationPaused')]);
  if (end <= start || !start || choice > 2n || (tied && choice !== 0n) || overridden ||
      funded.length > 1 || funded.some(n => n > 2n)) throw unavailable();

  let feeAsset: 'HNY' | null = null, base: bigint | null = null;
  let limits: { winner: bigint; loser: bigint; loserEnd: bigint } | null = null;
  if (p.appealKit === kit) {
    // Upstream Classic has the same timing getters; slot 1 alone does not establish the Honey build.
    try {
      const [localRuling,winner,loser,fraction] = await Promise.all([read(kit,coreAbi,'currentRuling',coreId), read(kit,appealReadAbi,'WINNER_STAKE_MULTIPLIER'),
        read(kit,appealReadAbi,'LOSER_STAKE_MULTIPLIER'), read(kit,appealReadAbi,'LOSER_APPEAL_PERIOD_MULTIPLIER')]);
      if (localRuling[0] === choice && localRuling[1] === tied && !localRuling[2] && winner === 10000n && loser === 20000n && fraction === 5000n)
        limits = { winner, loser, loserEnd: start + ((end-start)*fraction)/10000n };
    } catch { /* No verified per-choice terms. */ }
    if (limits && round.feeToken === honey) {
      try {
        if (await read(core,appealReadAbi,'getDisputeFeeToken',coreId) === honey && await read(honey,erc20Abi,'decimals') === 18) {
          feeAsset = 'HNY';
          const [nextCourt,nextKit,nextSeats,,kitJump] = await read(core,appealReadAbi,'getCourtAndDisputeKitJumps',coreId);
          if (nextCourt && (nextCourt === court || court !== 1n) && nextKit === 1n && nextSeats && !kitJump) {
            const cost = await read(core,appealReadAbi,'appealCostInFeeToken',coreId);
            if (cost > 0n && cost <= maxUint256 / limits.loser) base = cost;
          }
        }
      } catch { /* Missing converter/unsupported path: never substitute a native fee. */ }
    }
  }
  return { kind: input.kind, id: input.id, block: String(number), roundId: String(roundId), observedAt: String(timestamp),
    start: String(start), end: String(end), paused, preliminaryChoice: String(choice), tied, feeAsset, baseCostRaw: base?.toString() ?? null,
    choices: (['0','1','2'] as const).map(key => {
      const side = BigInt(key), winner = side === choice, paid = funded.includes(side);
      const cutoff = limits ? (winner ? end : limits.loserEnd) : null;
      return { choice: key, cutoff: cutoff?.toString() ?? null, funded: paid,
        open: cutoff === null ? null : !paused && !paid && timestamp >= start && timestamp < cutoff,
        targetRaw: base !== null && limits ? String(base + base*(winner ? limits.winner : limits.loser)/10000n) : null };
    }) };
}
