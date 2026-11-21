import { parseAbiItem, zeroAddress, type Abi, type ContractFunctionArgs, type ContractFunctionName, type ContractFunctionReturnType } from 'viem';
import { adapterAbi, classicAbi, coreAbi } from '../kleros-court/abis.js';
import type { ChainClient } from '../onehive/clients/chain.js';
import type { HexAddress } from '../onehive/schemas.js';
import { QueryFailure, type Kind, type Profile } from './profile.js';

export const evidenceEvent = parseAbiItem('event EvidenceSubmitted(uint256 indexed disputeId, address indexed submitter, bytes evidence)');
type EvidenceLog = { args: { submitter: HexAddress; evidence: `0x${string}` }; transactionHash: `0x${string}`; blockNumber?: bigint | null };
export type JuryDeps = {
  evidence: (adapter: HexAddress, dispute: bigint, fromBlock: bigint, toBlock: bigint) => Promise<EvidenceLog[]>;
  simulateBallot: (kit: HexAddress, account: HexAddress, args: ContractFunctionArgs<typeof classicAbi, 'nonpayable', 'castVote'>, block: bigint) => Promise<void>;
};
export type JuryRequest = { kind: Kind; id: string; account: HexAddress };
export type Ballot = JuryRequest & { roundId: string; voteIds: string[]; choice: 'refuse' | 'challenger' | 'submitter'; justification: string };
const choices = { refuse: 0n, challenger: 1n, submitter: 2n };
const same = (a: HexAddress, b: HexAddress) => a.toLowerCase() === b.toLowerCase();

function decodeEvidence(hex: `0x${string}`) {
  if (hex.length > 4098) return '[Evidence reference exceeds display limit]';
  try { return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(hex.slice(2), 'hex')); }
  catch { return hex; }
}

export async function readPartyEvidence(p: Profile, deps: JuryDeps, adapter: HexAddress, dispute: bigint, block: bigint) {
  const result: { status: 'not-configured' | 'unavailable' | 'complete'; items: { submitter: HexAddress; uri: string; transactionHash: string; block: string | null }[] } =
    { status: 'not-configured', items: [] };
  if (p.evidenceFromBlock === undefined) return result;
  result.status = 'unavailable';
  const first = BigInt(p.evidenceFromBlock);
  // shortcut: bounded RPC scan for fresh pilot deployments; use an index for older deployments.
  if (first > block || block - first >= 10_000n) return result;
  try {
    for (let start = first; start <= block; start += 2_000n) {
      const end = start + 1_999n;
      const logs = await deps.evidence(adapter, dispute, start, end < block ? end : block);
      if (result.items.length + logs.length > 100) throw new Error();
      for (const log of logs) result.items.push({ submitter: log.args.submitter, uri: decodeEvidence(log.args.evidence), transactionHash: log.transactionHash, block: log.blockNumber?.toString() ?? null });
    }
    result.status = 'complete';
  } catch { result.items = []; }
  return result;
}

export async function observeJury(p: Profile, client: ChainClient, link: {
  core: HexAddress; arbitrator: HexAddress; coreDispute: string; dispute: string; courtId: string;
  state: string; period: string;
}, account: HexAddress) {
  const read = <A extends Abi, F extends ContractFunctionName<A, 'view'>>(address: HexAddress, abi: A, functionName: F,
    ...args: ContractFunctionArgs<A, 'view', F> & readonly unknown[]) =>
    client.readContract<ContractFunctionReturnType<A, 'view', F>>({ address, abi, functionName, args: [...args] });
  const { core } = link;
  const coreId = BigInt(link.coreDispute);
  const [count, reverse, paused] = await Promise.all([
    read(core, coreAbi, 'getNumberOfRounds', coreId),
    read(link.arbitrator, adapterAbi, 'agreementDisputeByCore', coreId),
    read(core, coreAbi, 'arbitrationPaused')
  ]);
  if (count === 0n || reverse !== BigInt(link.dispute)) throw new QueryFailure('unavailable');
  const roundId = count - 1n;
  const round = await read(core, coreAbi, 'getRoundInfo', coreId, roundId);
  if (round.drawnJurors.length > 256 ||
      BigInt(round.drawnJurors.length) > round.nbVotes ||
      (link.period !== 'evidence' && BigInt(round.drawnJurors.length) !== round.nbVotes)) throw new QueryFailure('unavailable');
  const [kit, params] = await Promise.all([
    read(core, coreAbi, 'disputeKits', round.disputeKitID),
    read(core, coreAbi, 'getAdditionalCourtParams', BigInt(link.courtId), round.courtParamsIndex)
  ]);
  if (same(kit, zeroAddress)) throw new QueryFailure('unavailable');
  const [kitCore, [known, current]] = await Promise.all([
    read(kit, classicAbi, 'core'), read(kit, classicAbi, 'coreDisputeIDToActive', coreId)
  ]);
  if (!same(kitCore, core) || !known) throw new QueryFailure('unavailable');
  const seats = [];
  for (const [i, owner] of round.drawnJurors.entries()) {
    if (!same(owner, account)) continue;
    if (seats.length >= 16) throw new QueryFailure('unavailable');
    const [juror, , choice, voted] = await read(kit, classicAbi, 'getVoteInfo', coreId, roundId, BigInt(i));
    if (!same(juror, account) || (voted && choice > 2n)) throw new QueryFailure('unavailable');
    seats.push({ voteId: String(i), voted, choice: voted ? String(choice) : null });
  }
  const canPreview = p.jurySimulation && current && link.state === 'Active Kleros case' && link.period === 'vote' &&
    !paused && !params.hiddenVotes && seats.some(seat => !seat.voted);
  return { kit, coreId, core, courtId: link.courtId, timesPerPeriod: params.timesPerPeriod,
    drawn: BigInt(round.drawnJurors.length) === round.nbVotes, jury: { kitActive: current, roundId: String(roundId), period: link.period, hiddenVotes: params.hiddenVotes, paused, seats, canPreview } };
}

export async function previewBallot(input: Ballot, view: Awaited<ReturnType<typeof observeJury>>, deps: JuryDeps, block: bigint) {
  const { jury, kit, coreId } = view;
  if (!jury.canPreview || jury.roundId !== input.roundId ||
      input.voteIds.some(id => !jury.seats.some(seat => seat.voteId === id && !seat.voted))) throw new QueryFailure('jury-not-ready');
  try {
    await deps.simulateBallot(kit, input.account, [coreId, input.voteIds.map(BigInt), choices[input.choice], 0n, input.justification], block);
  } catch { throw new QueryFailure('simulation'); }
  return { simulation: 'success', method: 'castVote', from: input.account, to: kit, gas: null, block: String(block), roundId: jury.roundId };
}
