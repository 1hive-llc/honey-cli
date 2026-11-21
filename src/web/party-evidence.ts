import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, keccak256,
  stringToHex, zeroAddress, type Abi, type Address, type ContractFunctionArgs, type ContractFunctionName,
  type ContractFunctionReturnType } from 'viem';
import { adapterAbi, coreAbi } from '../kleros-court/abis.js';
import { agreementAbi, agreementChallengeStates, agreementResolutionAbi } from '../onehive/abis/agreement.js';
import { convictionVotingAbi } from '../onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../onehive/abis/disputableVoting.js';
import { ONEHIVE, TOKENS } from '../onehive/addresses.js';
import { publicEvidenceReference } from './public-reference.js';
import { QueryFailure, validAddress, validId, type Kind, type Profile } from './profile.js';
import type { StakeDeps } from './stake.js';

export type PartyEvidenceQuote = { kind: Kind; id: string; account: Address };
export type PartyEvidencePreview = PartyEvidenceQuote & { blockHash: string; reference: string };
const periods = ['evidence', 'commit', 'vote', 'appeal', 'execution'] as const;

export async function queryPartyEvidence(p: Profile, input: PartyEvidenceQuote | PartyEvidencePreview, rpc: StakeDeps) {
  if (!p.jurySimulation || p.chainId !== 31337 || !p.adapter || !validAddress(input.account) || !validId(input.id) ||
      !['proposals', 'votes'].includes(input.kind)) throw new QueryFailure('evidence-not-ready');
  const preview = 'reference' in input;
  if (preview && !publicEvidenceReference(input.reference)) throw new QueryFailure('evidence-not-ready');
  if (await rpc.chain() !== p.chainId) throw new QueryFailure('wrong-chain');
  const { hash } = await rpc.block();
  if (!hash) throw new QueryFailure('unavailable');
  if (preview && hash.toLowerCase() !== input.blockHash.toLowerCase()) throw new QueryFailure('evidence-stale');
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
  const action = cv ? (await read(app, convictionVotingAbi, 'getProposal', id))[6] : (await read(app, disputableVotingAbi, 'getVote', id))[7];
  if (!action) throw new QueryFailure('evidence-not-ready');
  const [linkedApp, localId, , setting, submitter, closed, , challenge, active] = await read(agreement, agreementAbi, 'getAction', action);
  if (closed || !active || !challenge || linkedApp !== app || localId !== id ||
      (await read(agreement, agreementResolutionAbi, 'getSetting', setting))[0] !== adapter) throw new QueryFailure('evidence-not-ready');
  const [linkedAction, challenger, , , , state, , , dispute, ruling] = await read(agreement, agreementAbi, 'getChallenge', challenge);
  const role = account === submitter ? 'submitter' : account === challenger ? 'challenger' : null;
  if (!role || linkedAction !== action || agreementChallengeStates[state] !== 'Disputed' || ruling !== 0n) throw new QueryFailure('evidence-not-ready');
  const [bound, core, honey, [coreId, pendingRuling, exists, finalised]] = await Promise.all([
    read(adapter, adapterAbi, 'agreement'), read(adapter, adapterAbi, 'core'), read(adapter, adapterAbi, 'honey'),
    read(adapter, adapterAbi, 'disputes', dispute)]);
  if (bound !== agreement || core === zeroAddress || (p.stake && core !== p.stake.core) || honey !== TOKENS.HNY || !exists ||
      finalised || pendingRuling !== 0n || BigInt(keccak256(encodeAbiParameters([{type:'address'}, {type:'uint256'}], [adapter,coreId]))) !== dispute)
    throw new QueryFailure('evidence-not-ready');
  const [reverse, [, arbitrated, periodCode, ruled], token] = await Promise.all([
    read(adapter, adapterAbi, 'agreementDisputeByCore', coreId), read(core, coreAbi, 'disputes', coreId), read(core, coreAbi, 'pinakion')]);
  const period = periods[periodCode];
  if (reverse !== dispute || token !== honey || arbitrated !== adapter || ruled || !period) throw new QueryFailure('evidence-not-ready');
  const quote = { kind: input.kind, id: input.id, account, blockHash: hash, actionId: String(action), role, period };
  if (!preview) return quote;
  // Agreement checks the party, forwards as itself, and ORs false with its existing finished flag.
  const data = encodeFunctionData({ abi: agreementAbi, functionName: 'submitEvidence', args: [dispute,stringToHex(input.reference),false] });
  try { if (await rpc.call({ from: account, to: agreement, data }, hash) !== '0x') throw new Error(); }
  catch { throw new QueryFailure('simulation'); }
  return { ...quote, submitted: false as const, byteLength: Buffer.byteLength(input.reference) };
}
