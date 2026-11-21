import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, maxUint256, parseAbi, stringToHex,
  zeroAddress, type Abi, type Address, type ContractFunctionArgs, type ContractFunctionName, type ContractFunctionReturnType } from 'viem';
import { coreAbi } from '../kleros-court/abis.js';
import { agreementAbi, agreementResolutionAbi } from '../onehive/abis/agreement.js';
import { convictionVotingAbi } from '../onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../onehive/abis/disputableVoting.js';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { ONEHIVE, TOKENS } from '../onehive/addresses.js';
import { detectLikelySecret } from '../onehive/policy.js';
import { adapterAbi } from '../onehive/tools/kleros.js';
import { QueryFailure, validAddress, validId, type Kind, type Profile } from './profile.js';
import { stakeTargetRaw, type StakeDeps } from './stake.js';

export const challengePermissionAbi = parseAbi(['function canPerformChallenge(uint256 actionId,address challenger) view returns (bool)']);
export type ChallengeQuote = { kind: Kind; id: string; account: Address };
export type ChallengePreview = ChallengeQuote & { blockHash: string; offerHny: string; context: string };

export async function queryChallenge(p: Profile, input: ChallengeQuote | ChallengePreview, rpc: StakeDeps) {
  if (!p.jurySimulation || p.chainId !== 31337 || !p.adapter || !validAddress(input.account) || !validId(input.id) ||
    !['proposals', 'votes'].includes(input.kind)) throw new QueryFailure('challenge-not-ready');
  const preview = 'offerHny' in input;
  const context = preview ? input.context.trim() : '';
  if (preview && (!/^(0|[1-9]\d{0,58})(?:\.\d{1,18})?$/.test(input.offerHny) ||
      !context || context.length > 500 || Buffer.byteLength(context) > 1024 || detectLikelySecret(context).length)) {
    throw new QueryFailure('challenge-not-ready');
  }
  if (await rpc.chain() !== p.chainId) throw new QueryFailure('wrong-chain');
  const { hash } = await rpc.block();
  if (!hash) throw new QueryFailure('unavailable');
  if (preview && input.blockHash.toLowerCase() !== hash.toLowerCase()) throw new QueryFailure('challenge-stale');

  // Same ABI as the CLI Agreement builder, but every read and the exact actor call use the same canonical hash.
  async function read<const A extends Abi, F extends ContractFunctionName<A, 'view'>>(to: Address, abi: A, fn: F,
    ...args: ContractFunctionArgs<A, 'view', F> & readonly unknown[]) {
    const binding = { abi: abi as Abi, functionName: fn as string };
    try {
      const bytes = await rpc.call({ to, data: encodeFunctionData({ ...binding, args }) }, hash!);
      const value = decodeFunctionResult({ ...binding, data: bytes });
      if (encodeFunctionResult({ ...binding, result: value }).toLowerCase() !== bytes.toLowerCase()) throw new Error();
      return value as ContractFunctionReturnType<A, 'view', F>;
    } catch { throw new QueryFailure('unavailable'); }
  }
  const account = getAddress(input.account), adapter = getAddress(p.adapter);
  const agreement = getAddress(p.env.ONEHIVE_AGREEMENT || ONEHIVE.AGREEMENT);
  const cv = input.kind === 'proposals', id = BigInt(input.id);
  const app = getAddress(cv ? p.env.ONEHIVE_CONVICTION_VOTING || ONEHIVE.CONVICTION_VOTING :
    p.env.ONEHIVE_DISPUTABLE_VOTING || ONEHIVE.DISPUTABLE_VOTING);
  const action = cv ? (await read(app, convictionVotingAbi, 'getProposal', id))[6] :
    (await read(app, disputableVotingAbi, 'getVote', id))[7];
  if (!action) throw new QueryFailure('challenge-not-ready');
  const [linkedApp, localId, requirement, setting, , closed, , , active] = await read(agreement, agreementAbi, 'getAction', action);
  if (linkedApp !== app || localId !== id || (await read(agreement, agreementResolutionAbi, 'getSetting', setting))[0] !== adapter) {
    throw new QueryFailure('challenge-not-ready');
  }
  const [bound, core, honey] = await Promise.all([read(adapter, adapterAbi, 'agreement'), read(adapter, adapterAbi, 'core'),
    read(adapter, adapterAbi, 'honey')]);
  if (bound !== agreement || honey !== TOKENS.HNY || core === zeroAddress || (p.stake && p.stake.core !== core) ||
      await read(core, coreAbi, 'pinakion') !== honey || await read(honey, erc20Abi, 'decimals') !== 18) throw new QueryFailure('challenge-not-ready');
  const [[token, , maximum, collateral], [recipient, feeToken, fee], canChallenge, canPerform, allowance, balance] = await Promise.all([
    read(agreement, agreementAbi, 'getCollateralRequirement', app, requirement), read(adapter, adapterAbi, 'getDisputeFees'),
    read(agreement, agreementAbi, 'canChallenge', action), read(agreement, challengePermissionAbi, 'canPerformChallenge', action, account),
    read(honey, erc20Abi, 'allowance', account, agreement), read(honey, erc20Abi, 'balanceOf', account)
  ]);
  const total = collateral + fee;
  if (recipient !== adapter || feeToken !== honey || token !== honey || total > maxUint256) throw new QueryFailure('challenge-not-ready');
  const eligible = !closed && !active && canChallenge && canPerform && allowance >= total && balance >= total;
  const quote = { kind: input.kind, id: input.id, account, blockHash: hash, agreement, adapter, core, actionId: String(action),
    maximumOfferRaw: String(maximum), challengerCollateralRaw: String(collateral), arbitratorFeeRaw: String(fee),
    totalDebitRaw: String(total), allowanceRaw: String(allowance), balanceRaw: String(balance), eligible };
  if (!preview) return quote;
  const offer = stakeTargetRaw(input.offerHny);
  if (!eligible || offer > maximum) throw new QueryFailure('challenge-not-ready');
  const data = encodeFunctionData({ abi: agreementAbi, functionName: 'challengeAction', args: [action, offer, false, stringToHex(context)] });
  try { if (await rpc.call({ from: account, to: agreement, data }, hash) !== '0x') throw new Error(); }
  catch { throw new QueryFailure('simulation'); }
  return { ...quote, settlementOfferRaw: String(offer), submitted: false as const };
}
