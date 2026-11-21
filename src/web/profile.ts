import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { devNull } from 'node:os';
import { parseEnv } from 'node:util';
import { getAddress, isAddress, zeroAddress } from 'viem';
import { ONEHIVE, CELESTE } from '../onehive/addresses.js';
import type { ChainId, HexAddress } from '../onehive/schemas.js';

export const pageSize = 8;
export const indexedStates = ['active', 'cancelled', 'executed', 'challenged', 'disputed', 'rejected', 'settled'] as const;
export type IndexedState = typeof indexedStates[number];
export class QueryFailure extends Error {
  constructor(readonly code: 'wrong-chain' | 'unavailable' | 'simulation' | 'jury-not-ready' | 'stake-not-configured' | 'stake-not-ready' | 'stake-stale' | 'decision-not-ready' | 'challenge-not-ready' | 'challenge-stale' | 'evidence-not-ready' | 'evidence-stale' | 'escalation-not-ready' | 'escalation-stale' | 'appeal-not-ready') { super(code); }
}
export type Kind = 'proposals' | 'votes';
export type Area = Kind | 'cases';
export const validId = (id: string) => /^(0|[1-9]\d{0,77})$/.test(id) && BigInt(id) < 2n ** 256n;
export function validAddress(value: string): value is HexAddress {
  return isAddress(value) && value.toLowerCase() !== zeroAddress;
}

export function readProfile(path: string) {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > 65536) throw new Error();
    const contents = Buffer.alloc(stat.size);
    if (readSync(file, contents, 0, contents.length, 0) !== contents.length) throw new Error();
    return parseEnv(contents.toString('utf8'));
  } finally { closeSync(file); }
}

export function parseProfile(input: Record<string, string | undefined>) {
  const chain = input.HONEY_WEB_CHAIN_ID || '100';
  if (!['100', '10200', '31337'].includes(chain)) throw new Error();
  const chainId = Number(chain) as ChainId;
  const rpcKey = {100: 'GNOSIS_RPC_URL', 10200: 'CHIADO_RPC_URL', 31337: 'FORK_RPC_URL'}[chainId];
  const rpcUrl = input[rpcKey];
  if (!rpcUrl) throw new Error();
  function endpoint(value: string) {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error();
    return value;
  }
  const env: Record<string, string> = { DOTENV_CONFIG_PATH: devNull, DOTENV_CONFIG_QUIET: 'true', TSX_DISABLE_CACHE: '1' };
  for (const key of ['ONEHIVE_CONVICTION_VOTING', 'ONEHIVE_DISPUTABLE_VOTING', 'ONEHIVE_AGREEMENT']) {
    const value = input[key];
    if (value) {
      if (!validAddress(value)) throw new Error();
      env[key] = value;
    }
  }
  const dao = input.ONEHIVE_DAO_KERNEL || ONEHIVE.DAO_KERNEL;
  const adapter = input.HONEY_WEB_ADAPTER || undefined;
  if (!validAddress(dao) || (adapter && (!validAddress(adapter) || (chainId === 100 && adapter.toLowerCase() === CELESTE.COURT.toLowerCase())))) throw new Error();
  const graphPrefix = chainId === 100 ? 'GARDENS_GNOSIS' : chainId === 10200 ? 'GARDENS_CHIADO' : undefined;
  const graph = (graphPrefix && input[graphPrefix + '_SUBGRAPH_URL']) || input.GARDENS_SUBGRAPH_URL;
  const graphKey = input.THE_GRAPH_API_KEY || input.GRAPH_API_KEY;
  const graphId = (graphPrefix && input[graphPrefix + '_SUBGRAPH_ID']) || input.GARDENS_SUBGRAPH_ID;
  // Forks have no implicit indexed counterpart. Require an explicit URL there.
  if (graph) env.GARDENS_SUBGRAPH_URL = endpoint(graph);
  else if (chainId !== 31337 && graphKey && (chainId === 100 || graphId)) {
    env.THE_GRAPH_API_KEY = graphKey;
    if (graphId) env.GARDENS_SUBGRAPH_ID = graphId;
  }
  function ids(raw: string | undefined) {
    if (!raw?.trim()) return [];
    const values = raw.split(',').map(s => s.trim());
    if (values.length > 256 || !values.every(validId)) throw new Error();
    return [...new Set(values)];
  }
  const known = { proposals: ids(input.HONEY_WEB_PROPOSALS), votes: ids(input.HONEY_WEB_VOTES) };
  const indexed = Boolean(env.GARDENS_SUBGRAPH_URL || env.THE_GRAPH_API_KEY);
  const source = known.proposals.length || known.votes.length ? 'known-ids' : indexed ? 'gardens' : 'none';
  const evidenceFromBlock = input.HONEY_WEB_ADAPTER_FROM_BLOCK || undefined;
  if (evidenceFromBlock !== undefined && (!adapter || !validId(evidenceFromBlock))) throw new Error();
  const jurySimulation = chainId === 31337 && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(rpcUrl).hostname);
  const appealKit = input.HONEY_WEB_APPEAL_KIT || undefined;
  if (appealKit && (!adapter || !validAddress(appealKit))) throw new Error();
  const stakeCore = input.HONEY_WEB_STAKE_CORE;
  const stakeCourtId = input.HONEY_WEB_STAKE_COURT_ID;
  if ((stakeCore !== undefined || stakeCourtId !== undefined) &&
      (!adapter || !stakeCore || !validAddress(stakeCore) || !stakeCourtId || !validId(stakeCourtId) ||
      BigInt(stakeCourtId) === 0n || BigInt(stakeCourtId) >= 2n ** 96n)) throw new Error();
  const stake = stakeCore && stakeCourtId ? { core: getAddress(stakeCore), courtId: stakeCourtId } : undefined;
  return { stake, appealKit: appealKit ? getAddress(appealKit) : undefined, evidenceFromBlock, jurySimulation, chainId, dao, adapter: adapter as HexAddress | undefined, rpcUrl: endpoint(rpcUrl), env, known, source } as const;
}
export type Profile = ReturnType<typeof parseProfile>;
