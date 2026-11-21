import { decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress,
  zeroAddress, type Abi, type Address, type ContractFunctionArgs, type ContractFunctionName, type ContractFunctionReturnType } from 'viem';
import { coreAbi } from '../kleros-court/abis.js';
import { agreementAbi, agreementChallengeStates, agreementResolutionAbi } from '../onehive/abis/agreement.js';
import { convictionVotingAbi } from '../onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../onehive/abis/disputableVoting.js';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { ONEHIVE, TOKENS } from '../onehive/addresses.js';
import { adapterAbi } from '../onehive/tools/kleros.js';
import { QueryFailure, validAddress, validId, type Kind, type Profile } from './profile.js';
import type { StakeDeps } from './stake.js';

export type EscalationQuote = { kind: Kind; id: string; account: Address };
export type EscalationPreview = EscalationQuote & { blockHash: string };

export async function queryEscalation(p: Profile, input: EscalationQuote | EscalationPreview, rpc: StakeDeps) {
  if (!p.jurySimulation || p.chainId !== 31337 || !p.adapter || !validAddress(input.account) || !validId(input.id) ||
      !['proposals', 'votes'].includes(input.kind)) throw new QueryFailure('escalation-not-ready');
  const preview = 'blockHash' in input;
  if (await rpc.chain() !== p.chainId) throw new QueryFailure('wrong-chain');
  const { hash, timestamp } = await rpc.block();
  if (!hash) throw new QueryFailure('unavailable');
  if (preview && input.blockHash.toLowerCase() !== hash.toLowerCase()) throw new QueryFailure('escalation-stale');

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
  if (!action) throw new QueryFailure('escalation-not-ready');
  const [linkedApp, localId, , setting, submitter, closed, , challenge, active] = await read(agreement, agreementAbi, 'getAction', action);
  if (closed || !active || !challenge || submitter === zeroAddress || linkedApp !== app || localId !== id || (await read(agreement, agreementResolutionAbi, 'getSetting', setting))[0] !== adapter) {
    throw new QueryFailure('escalation-not-ready');
  }
  const [bound, core, honey] = await Promise.all([read(adapter, adapterAbi, 'agreement'), read(adapter, adapterAbi, 'core'),
    read(adapter, adapterAbi, 'honey')]);
  if (bound !== agreement || honey !== TOKENS.HNY || core === zeroAddress || (p.stake && p.stake.core !== core) ||
      await read(core, coreAbi, 'pinakion') !== honey || await read(honey, erc20Abi, 'decimals') !== 18) throw new QueryFailure('escalation-not-ready');
  const [linkedAction, challenger, deadline, , , state, , , dispute, ruling] = await read(agreement, agreementAbi, 'getChallenge', challenge);
  if (linkedAction !== action || challenger === zeroAddress || agreementChallengeStates[state] !== 'Waiting' || dispute !== 0n || ruling !== 0n)
    throw new QueryFailure('escalation-not-ready');
  const [[recordedSubmitterToken, recordedSubmitterFee, escrowToken, escrow], [recipient, freshToken, fee], canDispute, balance, allowance] = await Promise.all([
    read(agreement, agreementAbi, 'getChallengeArbitratorFees', challenge), read(adapter, adapterAbi, 'getDisputeFees'),
    read(agreement, agreementAbi, 'canDispute', action), read(honey, erc20Abi, 'balanceOf', account),
    read(honey, erc20Abi, 'allowance', account, agreement)]);
  if (recordedSubmitterToken !== zeroAddress || recordedSubmitterFee !== 0n || escrowToken !== honey ||
      recipient !== adapter || freshToken !== honey) throw new QueryFailure('escalation-not-ready');
  const eligible = account === submitter && timestamp < deadline && canDispute && balance >= fee && allowance >= fee;
  const quote = { kind: input.kind, id: input.id, account, blockHash: hash, actionId: String(action), challengeId: String(challenge),
    deadline: String(deadline), challengerFeeEscrowRaw: String(escrow), submitterFeeRaw: String(fee),
    balanceRaw: String(balance), allowanceRaw: String(allowance), eligible };
  if (!preview) return quote;
  if (!eligible) throw new QueryFailure('escalation-not-ready');
  const data = encodeFunctionData({ abi: agreementAbi, functionName: 'disputeAction', args: [action,false] });
  try { if (await rpc.call({ from: account, to: agreement, data }, hash) !== '0x') throw new Error(); }
  catch { throw new QueryFailure('simulation'); }
  return { ...quote, submitted: false as const };
}
