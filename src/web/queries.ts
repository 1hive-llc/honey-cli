import { createPublicClient, encodeFunctionData, http } from 'viem';
import { createViemChainClient, type ChainClient, type ContractReadRequest } from '../onehive/clients/chain.js';
import { listGardenProposals, resolveGardensSubgraphUrl, type GardenProposalSummary } from '../onehive/clients/garden.js';
import { readConvictionProposal, buildAddProposalPreview, convictionVotingAddress } from '../onehive/tools/governance.js';
import { readDecisionVote, decisionVotingAddress } from '../onehive/tools/decision.js';
import { readAgreementCourtStatus } from '../onehive/tools/agreement-court.js';
import { pageSize, validId, QueryFailure, type IndexedState, type Area, type Kind, type Profile } from './profile.js';
import type { HexAddress } from '../onehive/schemas.js';

import { evidenceEvent, observeJury, previewBallot, readPartyEvidence, type Ballot, type JuryDeps, type JuryRequest } from './jury.js';
import { readSettlement } from './settlement.js';
import { readJuryTiming } from './jury-timing.js';
import { previewDecisionVote, type DecisionVotePreviewInput } from './decision-preview.js';
import { queryStakeAllowance, type StakeAllowancePreview } from './stake-allowance.js';
import { queryAppealWindow } from './appeal-window.js';
import { queryEscalation, type EscalationQuote, type EscalationPreview } from './escalation.js';
import { queryPartyEvidence, type PartyEvidenceQuote, type PartyEvidencePreview } from './party-evidence.js';
import { queryChallenge, type ChallengeQuote, type ChallengePreview } from './challenge.js';
import { queryStake, type StakeDeps, type StakePreview, type StakeRead } from './stake.js';
import { classicAbi } from '../kleros-court/abis.js';

export { QueryFailure };
export type ProposalInput = { from: HexAddress; beneficiary: HexAddress; title: string; link: string; amount: string; stable: boolean };
export type Query = { op: 'list'; area: Area; page: number; state?: IndexedState } | { op: 'detail'; kind: Kind; id: string } | { op: 'preview'; input: ProposalInput } | { op: 'jury'; input: JuryRequest } | { op: 'jury-preview'; input: Ballot } | { op: 'settlement'; kind: Kind; id: string } | { op: 'appeal'; kind: Kind; id: string } | { op: 'escalation'; input: EscalationQuote } | { op: 'escalation-preview'; input: EscalationPreview } | { op: 'evidence'; input: PartyEvidenceQuote } | { op: 'evidence-preview'; input: PartyEvidencePreview } | { op: 'challenge'; input: ChallengeQuote } | { op: 'challenge-preview'; input: ChallengePreview } | { op: 'decision-preview'; input: DecisionVotePreviewInput } | { op: 'stake-allowance'; input: StakeAllowancePreview } | { op: 'jury-inbox'; account: HexAddress; page: number } | { op: 'stake'; input: StakeRead } | { op: 'stake-preview'; input: StakePreview };
type Candidate = { kind: Kind; id: string; title: string; state: string };
type Deps = { client: ChainClient; index: typeof listGardenProposals; jury?: JuryDeps; juryClock?: (block: bigint) => Promise<bigint | undefined>; stake?: StakeDeps };
type CourtAction = NonNullable<NonNullable<Awaited<ReturnType<typeof readAgreementCourtStatus>>['data']>['action']>;

// Limit decoded upstream bytes too (Content-Length can be missing or compressed).
async function boundedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const res = await fetch(input, { ...init, redirect: 'error' });
  if (!res.ok || !res.body) {
    await res.body?.cancel();
    throw new QueryFailure('unavailable');
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 1024 * 1024) { await reader.cancel(); throw new QueryFailure('unavailable'); }
    chunks.push(value);
  }
  return new Response(Buffer.concat(chunks), { headers: { 'content-type': 'application/json' } });
}

export function liveDependencies(p: Profile): Deps {
  const transport = http(p.rpcUrl, { fetchFn: boundedFetch, timeout: 6000, retryCount: 0,
    methods: { include: ['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call', 'eth_getCode', 'eth_estimateGas', 'eth_getLogs'] } });
  const client = createViemChainClient({ chainId: p.chainId, rpcUrl: p.rpcUrl, transport });
  const rpc = createPublicClient({ transport });
  const jury: JuryDeps = {
    evidence: (address, disputeId, fromBlock, toBlock) =>
      rpc.getLogs({ address, event: evidenceEvent, strict: true, args: { disputeId }, fromBlock, toBlock }),
    async simulateBallot(to, account, args, blockNumber) {
      await rpc.call({ to, account, data: encodeFunctionData({ abi: classicAbi, functionName: 'castVote', args }), blockNumber });
    }
  };
  // The shared CLI factory also serves wallet callers. Keep signing out of this worker's client.
  delete client.sendTransaction;
  const stake: StakeDeps = {
    chain: () => rpc.getChainId(),
    block: () => rpc.getBlock({ blockTag: 'latest' }),
    call: (call, blockHash) => rpc.request({ method: 'eth_call', params: [call, { blockHash, requireCanonical: true }] })
  };
  return { client, jury, stake, juryClock: async blockNumber => {
    const block = await rpc.getBlock({ blockNumber });
    return block.number === blockNumber && block.hash ? block.timestamp : undefined;
  }, index: params => listGardenProposals(params, {
    includeIndexMeta: true,
    graphqlRequest: async (url, query, variables) => {
      const response = await boundedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(6000) });
      const result = await response.json();
      if (result.errors || !Array.isArray(result.data?.proposals) || result.data.proposals.length > pageSize + 1) throw new QueryFailure('unavailable');
      if (result.data.proposals.some((row: { organization?: { id?: string } } | null) =>
          row?.organization?.id?.toLowerCase() !== p.dao.toLowerCase())) throw new QueryFailure('unavailable');
      return result.data;
    }, subgraphUrl: resolveGardensSubgraphUrl(p.chainId).data!
  }) };
}

async function snapshot(p: Profile, client: ChainClient) {
  if (await client.getChainId() !== p.chainId) throw new QueryFailure('wrong-chain');
  if (!client.getBlockNumber) throw new QueryFailure('unavailable');
  const block = await client.getBlockNumber();
  // The same Agreement setting and app getter can appear repeatedly on one page.
  // Each entry is a view result scoped to this one block and request.
  const reads = new Map<string, Promise<unknown>>();
  const pinned: ChainClient = { ...client, getChainId: async () => p.chainId, getBlockNumber: async () => block,
    readContract<T>(req: ContractReadRequest) {
      const key = JSON.stringify([req.address, req.functionName, req.args ?? []], (_k, v) => typeof v === 'bigint' ? String(v) : v);
      if (!reads.has(key)) reads.set(key, client.readContract({ ...req, blockNumber: block }));
      return reads.get(key)! as Promise<T>;
    } };
  return { client: pinned, block: String(block) };
}

function classify(action: CourtAction) {
  const ch = action.latestChallenge;
  if (!ch) return 'No challenge';
  if (ch.state === 'Unknown') return 'Unknown';
  if (ch.disputeId === null) return 'No dispute';
  if (action.setting.kind === 'legacy-celeste') return 'Legacy Celeste';
  const court = ch.court;
  if (action.setting.kind !== 'configured-kleros-adapter' || !court || court.coreRuled === null ||
      court.coreRuled !== court.finalised || court.period === 'unknown' || court.period === null) return 'Unknown';
  if (ch.state === 'Disputed') {
    if (action.closed || !ch.active) return 'Unknown';
    return court.finalised ? 'Awaiting Agreement resolution' : 'Active Kleros case';
  }
  return !ch.active && court.finalised && court.adapterAgreementRuling === ch.agreementRuling ? 'Resolved' : 'Unknown';
}

async function courtStatus(p: Profile, record: { kind: Kind; id: string }, client: ChainClient) {
  const selector = record.kind === 'proposals' ? { proposalId: record.id } : { voteId: record.id };
  const result = await readAgreementCourtStatus({ chainId: p.chainId, ...(p.adapter ? { adapter: p.adapter } : {}), ...selector }, client);
  const action = result.data?.action;
  if (!result.ok || !action) return { state: 'Unknown' as const, reason: 'Agreement link unavailable or inconsistent.' };
  const ch = action.latestChallenge;
  return { state: classify(action), agreement: result.data!.agreement, actionId: action.actionId, closed: action.closed,
    app: action.app, collateralRequirementId: action.collateralRequirementId,
    setting: action.setting.settingId, arbitrator: action.setting.arbitrator, courtKind: action.setting.kind,
    challenge: ch?.challengeId ?? null, challengeState: action.challengeState, challengeActive: ch?.active ?? null, dispute: ch?.disputeId ?? null,
    agreementRuling: ch?.agreementRuling ?? null, core: ch?.court?.core ?? null,
    coreDispute: ch?.court?.coreDisputeId ?? null, courtId: ch?.court?.currentCourtId ?? null,
    period: ch?.court?.period ?? null, adapterFinalised: ch?.court?.finalised ?? null, coreRuled: ch?.court?.coreRuled ?? null,
    adapterRuling: ch?.court?.adapterAgreementRuling ?? null };
}

async function appDetail(p: Profile, kind: Kind, id: string, client: ChainClient) {
  if (kind === 'proposals') return readConvictionProposal({ proposalId: id, chainId: p.chainId }, client);
  const result = await readDecisionVote({ voteId: id, chainId: p.chainId }, { client });
  if (!result.ok || !result.data) throw new QueryFailure('unavailable');
  return result.data;
}

function candidate(item: GardenProposalSummary): Candidate | null {
  const type = item.type?.toLowerCase();
  const kind = type === 'decision' ? 'votes' : type === 'proposal' || type === 'suggestion' ? 'proposals' : null;
  if (!kind || !item.number || !validId(item.number)) return null;
  return { kind, id: item.number, title: (item.title || '').slice(0, 500), state: (item.status || 'Unknown').slice(0, 60) };
}

async function candidates(p: Profile, { area, page, state }: Extract<Query, { op: 'list' }>, deps: Deps) {
  const skip = (page - 1) * pageSize;
  let records: (Candidate | null)[];
  let indexBlock: string | null = null;
  let indexingErrors = false;
  if (p.source === 'gardens') {
    const types = area === 'proposals' ? ['proposal', 'suggestion'] : area === 'votes' ? ['decision'] : ['proposal', 'suggestion', 'decision'];
    const result = await deps.index({ dao: p.dao, network: p.chainId, first: pageSize + 1, skip, types, ...(state ? { statuses: [state] } : {}), orderBy: 'createdAt', orderDirection: 'desc' });
    records = result.data.map(candidate);
    indexBlock = result.indexBlock ?? null;
    indexingErrors = result.indexingErrors === true;
  } else {
    const kinds: Kind[] = area === 'cases' ? ['proposals', 'votes'] : [area];
    records = kinds.flatMap(kind => p.known[kind].map(id => ({ kind, id, state: 'Unknown', title: '' }))).slice(skip, skip + pageSize + 1);
  }
  const pageRecords = records.slice(0, pageSize);
  const items = pageRecords.filter((r): r is Candidate => r !== null && (area === 'cases' || r.kind === area));
  return { items, indexBlock, indexingErrors, hasNext: records.length > pageSize, scanned: pageRecords.length, unknown: pageRecords.length - items.length };
}

function juryBinding(link: Awaited<ReturnType<typeof courtStatus>>) {
  if (link.courtKind !== 'configured-kleros-adapter' || !link.core || !link.arbitrator || !link.coreDispute ||
      !link.dispute || !link.courtId || !link.period || link.state === 'Unknown') return null;
  return { ...link, core: link.core, arbitrator: link.arbitrator, coreDispute: link.coreDispute,
    dispute: link.dispute, courtId: link.courtId, period: link.period };
}

const emptyPage = { rows: [], hasNext: false, scanned: 0, unknown: 0, block: null, indexBlock: null, indexingErrors: false };

async function juryInbox(p: Profile, q: Extract<Query, { op: 'jury-inbox' }>, deps: Deps) {
  if (!p.adapter) return { ...emptyPage, coverage: 'no-adapter' };
  if (p.source === 'none') return { ...emptyPage, coverage: 'no-list-source' };
  // shortcut: use the bounded governance page, not a global juror index.
  const { items, scanned, unknown: malformed, hasNext, indexBlock, indexingErrors } =
    await candidates(p, { op: 'list', area: 'cases', page: q.page }, deps);
  const snap = items.length ? await snapshot(p, deps.client) : null;
  let unknown = malformed;
  async function observedAssignment(row: Candidate) {
    if (!snap) return;
    try {
      const link = await courtStatus(p, row, snap.client);
      if (link.state === 'Unknown') throw new QueryFailure('unavailable');
      if (link.state !== 'Active Kleros case' && link.state !== 'Awaiting Agreement resolution') return;
      const binding = juryBinding(link);
      if (!binding) throw new QueryFailure('unavailable');
      const { jury } = await observeJury(p, snap.client, binding, q.account);
      if (!jury.seats.length) return;
      const outstanding = jury.seats.some(seat => !seat.voted);
      const status = binding.state === 'Awaiting Agreement resolution' ? 'waiting'
        : jury.period === 'appeal' ? 'appeal'
        : jury.period === 'vote' || jury.period === 'commit'
          ? !outstanding ? 'voted'
            : jury.period === 'commit' || jury.paused || jury.hiddenVotes || !jury.kitActive ? 'unsupported' : 'vote-needed'
          : 'waiting';
      return { ...row, state: link.state, roundId: jury.roundId, period: jury.period, seats: jury.seats, status };
    } catch { unknown++; }
  }
  const rows: NonNullable<Awaited<ReturnType<typeof observedAssignment>>>[] = [];
  const seen = new Set<string>();
  const unique = items.filter(row => {
    const key = row.kind + '/' + row.id;
    if (seen.has(key)) { unknown++; return false; }
    seen.add(key);
    return true;
  });
  for (let i = 0; i < unique.length; i += 2) {
    const assignments = await Promise.all(unique.slice(i, i + 2).map(observedAssignment));
    for (const assignment of assignments) if (assignment) rows.push(assignment);
  }
  return { rows, hasNext, scanned, unknown, block: snap?.block ?? null, indexBlock, indexingErrors,
    coverage: unknown || indexingErrors ? 'partial' : 'page' };
}

export async function query(p: Profile, q: Query, deps: Deps) {
  const { client } = deps;
  if (q.op === 'appeal') {
    if (!deps.stake) throw new QueryFailure('appeal-not-ready');
    return queryAppealWindow(p, { kind: q.kind, id: q.id }, deps.stake);
  }
  if (q.op === 'escalation' || q.op === 'escalation-preview') {
    if (!deps.stake) throw new QueryFailure('escalation-not-ready');
    return queryEscalation(p, q.input, deps.stake);
  }
  if (q.op === 'evidence' || q.op === 'evidence-preview') {
    if (!deps.stake) throw new QueryFailure('evidence-not-ready');
    return queryPartyEvidence(p, q.input, deps.stake);
  }
  if (q.op === 'challenge' || q.op === 'challenge-preview') {
    if (!deps.stake) throw new QueryFailure('challenge-not-ready');
    return queryChallenge(p, q.input, deps.stake);
  }
  if (q.op === 'decision-preview') return previewDecisionVote(p, q.input, client);
  if (q.op === 'stake-allowance') {
    if (!deps.stake) throw new QueryFailure('stake-not-configured');
    return queryStakeAllowance(p, q.input, deps.stake);
  }
  if (q.op === 'jury-inbox') return juryInbox(p, q, deps);
  if (q.op === 'stake' || q.op === 'stake-preview') {
    if (!deps.stake) throw new QueryFailure('stake-not-configured');
    return queryStake(p, q.input, deps.stake);
  }
  if (q.op === 'preview') {
    const v = q.input;
    const result = await buildAddProposalPreview({ chainId: p.chainId, from: v.from, beneficiary: v.beneficiary,
      title: v.title, link: v.link, requestedAmountHnyOrWxDai: v.amount, stableRequestAmount: v.stable }, { client });
    if (!result.ok || result.data?.simulation.status !== 'success') throw new QueryFailure('simulation');
    const tx = result.data;
    return { simulation: tx.simulation.status, method: tx.decoded.method, from: tx.from, to: tx.to,
      gas: tx.simulation.gasEstimate ?? null, checks: tx.policy.checks.map(c => ({ name: c.name, status: c.status })), block: null };
  }
  if (q.op === 'jury' || q.op === 'jury-preview') {
    if (!p.adapter || !deps.jury) throw new QueryFailure('jury-not-ready');
    const snap = await snapshot(p, client);
    const link = await courtStatus(p, q.input, snap.client);
    const binding = juryBinding(link);
    if (!binding) throw new QueryFailure('jury-not-ready');
    const view = await observeJury(p, snap.client, binding, q.input.account);
    if (q.op === 'jury-preview') return previewBallot(q.input, view, deps.jury, BigInt(snap.block));
    const block = BigInt(snap.block);
    const [evidence, timestamp] = await Promise.all([
      readPartyEvidence(p, deps.jury, binding.arbitrator, BigInt(binding.dispute), block),
      deps.juryClock?.(block).catch(() => undefined)
    ]);
    const timing = await readJuryTiming(snap.client, view, timestamp);
    return { jury: view.jury, evidence, timing, block: snap.block };
  }
  if (q.op === 'settlement') {
    const snap = await snapshot(p, client);
    const link = await courtStatus(p, q, snap.client);
    return { receipt: await readSettlement(snap.client, link), block: snap.block };
  }
  if (q.op === 'detail') {
    const snap = await snapshot(p, client);
    const data = await appDetail(p, q.kind, q.id, snap.client);
    const court = await courtStatus(p, q, snap.client);
    return { kind: q.kind, id: q.id, app: q.kind === 'proposals' ? convictionVotingAddress() : decisionVotingAddress(),
      data, court, block: snap.block };
  }
  if (q.area === 'cases' && !p.adapter) return { ...emptyPage, coverage: 'no-adapter' };
  if (p.source === 'none') return { ...emptyPage, coverage: 'no-list-source' };
  const { items, hasNext, scanned, indexBlock, indexingErrors, unknown: malformed } = await candidates(p, q, deps);
  const needsRpc = q.area === 'cases' || p.source === 'known-ids';
  const snap = needsRpc && items.length ? await snapshot(p, client) : null;
  const area = q.area;
  async function observe(row: Candidate) {
    if (!snap) return row;
    if (area === 'cases') {
      const court = await courtStatus(p, row, snap.client);
      return { ...row, state: court.state, court };
    }
    try {
      const detail = await appDetail(p, row.kind, row.id, snap.client);
      return { ...row, state: detail.status };
    } catch { return { ...row, state: 'Unknown' }; }
  }
  const observed = [];
  for (let i = 0; i < items.length; i += 2) {
    observed.push(...await Promise.all(items.slice(i, i + 2).map(observe)));
  }
  const unknown = malformed + observed.filter(row => row.state.startsWith('Unknown')).length;
  const rows = q.area === 'cases' ? observed.filter(row =>
    ['Active Kleros case', 'Awaiting Agreement resolution', 'Unknown'].includes(row.state)) : observed;
  return { rows, hasNext, scanned, unknown, indexBlock, indexingErrors, block: snap?.block ?? null,
    coverage: unknown || indexingErrors ? 'partial' : 'page' };
}
