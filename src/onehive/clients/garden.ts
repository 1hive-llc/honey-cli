import 'dotenv/config';
import { request } from 'graphql-request';
import type { ChainId, HexAddress } from '../schemas.js';

const MAX_PAGE_SIZE = 50;
const DEFAULT_PAGE_SIZE = 20;
const MAX_STRING_LENGTH = 500;
const DEPRECATED_GARDENS_GNOSIS_SUBGRAPH_ID = 'EucdbfTKw6d9DFeA2yHP8W9ZPciQGpAQHZMFCy3i7TxZ';
const GARDENS_GNOSIS_SUBGRAPH_ID = 'G4EbcSW588SUy8CdprPPxCN69VN8mxvnwt4oyR6YpGza';

export type GardenListParams = {
  network: ChainId;
  first?: number;
  skip?: number;
  orderBy?: 'honeyLiquidity' | 'createdAt' | 'name';
};

export type GardenProposalsParams = {
  dao: string;
  network: ChainId;
  first?: number;
  skip?: number;
  statuses?: string[];
  types?: string[];
  orderBy?: 'createdAt' | 'updatedAt' | 'staked';
  orderDirection?: 'asc' | 'desc';
};

export type GardenUserParams = {
  address: HexAddress;
  network: ChainId;
};

export type GardenSummary = {
  id: string;
  name?: string;
  chainId: number;
  dao?: string;
  token?: { id?: string; symbol?: string; name?: string; decimals?: number };
  proposalCount?: number;
  supporterCount?: number;
  honeyLiquidity?: string;
  active?: boolean;
};

export type GardenProposalSummary = {
  id: string;
  number?: string;
  title?: string;
  creator?: string;
  beneficiary?: string;
  requestedAmount?: string;
  status?: string;
  type?: string;
  metadataUri?: string;
  link?: string;
  createdAt?: string;
  updatedAt?: string;
  totalTokensStaked?: string;
  stable?: boolean;
};

export type GardenUserSummary = {
  id: string;
  address?: HexAddress;
  gardensSigned?: string[];
  supports: Array<{ id?: string; organization?: string; representative?: string }>;
};

export type GardenConvictionConfig = {
  id: string;
  decay: string;
  weight?: string;
  maxRatio?: string;
  pctBase: string;
  totalStaked?: string;
  minThresholdStakePercentage?: string;
};

type GraphqlRequest = <T = unknown>(url: string, query: string, variables?: Record<string, unknown>) => Promise<T>;

export type GardenConnectorDeps = {
  includeIndexMeta?: boolean;
  graphqlRequest?: GraphqlRequest;
  subgraphUrl?: string;
};

export type GardenReadResult<T> = {
  indexBlock?: string;
  indexingErrors?: boolean;
  data: T;
  warnings: string[];
};

const STATUS_TO_INT: Record<string, number> = {
  active: 0,
  cancelled: 1,
  executed: 2,
  challenged: 3,
  disputed: 4,
  rejected: 5,
  settled: 6
};

const TYPE_TO_INT: Record<string, number> = {
  suggestion: 0,
  proposal: 1,
  decision: 2,
  stream: 3
};

const defaultGraphqlRequest: GraphqlRequest = async <T>(url: string, query: string, variables?: Record<string, unknown>) => request<T>(url, query, variables);

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function optionalString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  return String(value);
}

function optionalNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value !== '') return Number(value);
  return undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function truncateString(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]` : value;
}

export function normalizePage(first: number | undefined, skip: number | undefined, warnings: string[]): { first: number; skip: number } {
  let normalizedFirst = first ?? DEFAULT_PAGE_SIZE;
  if (!Number.isFinite(normalizedFirst) || normalizedFirst < 1) normalizedFirst = DEFAULT_PAGE_SIZE;
  if (normalizedFirst > MAX_PAGE_SIZE) {
    warnings.push(`Page size capped from ${normalizedFirst} to ${MAX_PAGE_SIZE}.`);
    normalizedFirst = MAX_PAGE_SIZE;
  }

  let normalizedSkip = skip ?? 0;
  if (!Number.isFinite(normalizedSkip) || normalizedSkip < 0) normalizedSkip = 0;
  return { first: normalizedFirst, skip: normalizedSkip };
}

function normalizeGardensSubgraphId(id: string | undefined, warnings: string[]): string | undefined {
  if (!id) return id;
  if (id === DEPRECATED_GARDENS_GNOSIS_SUBGRAPH_ID) {
    warnings.push('Configured Gardens Gnosis subgraph ID is deprecated/unqueryable; using the current Gardens app subgraph ID instead.');
    return GARDENS_GNOSIS_SUBGRAPH_ID;
  }
  return id;
}

export function resolveGardensSubgraphUrl(network: ChainId): GardenReadResult<string | undefined> {
  const warnings: string[] = [];
  const networkSpecificUrl = network === 100 ? process.env.GARDENS_GNOSIS_SUBGRAPH_URL : process.env.GARDENS_CHIADO_SUBGRAPH_URL;
  const directUrl = networkSpecificUrl ?? process.env.GARDENS_SUBGRAPH_URL;
  if (directUrl) return { data: directUrl, warnings };

  const graphApiKey = process.env.THE_GRAPH_API_KEY ?? process.env.GRAPH_API_KEY;
  const networkSpecificId = network === 100 ? process.env.GARDENS_GNOSIS_SUBGRAPH_ID : process.env.GARDENS_CHIADO_SUBGRAPH_ID;
  const subgraphId = normalizeGardensSubgraphId(networkSpecificId ?? process.env.GARDENS_SUBGRAPH_ID ?? (network === 100 ? GARDENS_GNOSIS_SUBGRAPH_ID : undefined), warnings);
  if (graphApiKey && subgraphId) {
    return { data: `https://gateway.thegraph.com/api/${graphApiKey}/subgraphs/id/${subgraphId}`, warnings };
  }

  if (network === 100) {
    warnings.push('No Gardens subgraph endpoint configured. Set GARDENS_SUBGRAPH_URL or THE_GRAPH_API_KEY; legacy @1hive/connect-gardens fallback has been removed.');
  } else {
    warnings.push(`No Gardens subgraph endpoint configured for chain ${network}; set GARDENS_SUBGRAPH_URL or GARDENS_CHIADO_SUBGRAPH_URL.`);
  }
  return { data: undefined, warnings };
}

function requireGardensSubgraphUrl(network: ChainId, warnings: string[]): string {
  const subgraph = resolveGardensSubgraphUrl(network);
  warnings.push(...subgraph.warnings);
  if (!subgraph.data) throw new Error(warnings.at(-1) ?? 'Gardens subgraph endpoint is required.');
  return subgraph.data;
}

function mapFilterValues(values: string[] | undefined, lookup: Record<string, number>, label: string, warnings: string[]): number[] | undefined {
  if (!values || values.length === 0) return undefined;
  const mapped: number[] = [];
  for (const value of values) {
    const normalized = value.trim().toLowerCase();
    const parsed = /^\d+$/.test(normalized) ? Number(normalized) : lookup[normalized];
    if (typeof parsed === 'number') mapped.push(parsed);
    else warnings.push(`Ignored unknown Garden proposal ${label} filter: ${value}.`);
  }
  return mapped.length > 0 ? mapped : undefined;
}

function setIfDefined<T extends Record<string, unknown>, K extends string, V>(target: T, key: K, value: V | undefined): asserts target is T & Partial<Record<K, V>> {
  if (value !== undefined) (target as Record<string, unknown>)[key] = value;
}

export function summarizeGarden(raw: unknown, network: ChainId): GardenSummary {
  const garden = asRecord(raw);
  const config = asRecord(garden.config);
  const token = asRecord(garden.token);
  const summary: GardenSummary = { id: optionalString(garden.id) ?? '', chainId: network };
  setIfDefined(summary, 'name', optionalString(garden.name) ?? optionalString(token.name));
  setIfDefined(summary, 'dao', optionalString(garden.id));
  if (Object.keys(token).length > 0) {
    const tokenSummary: NonNullable<GardenSummary['token']> = {};
    setIfDefined(tokenSummary, 'id', optionalString(token.id));
    setIfDefined(tokenSummary, 'symbol', optionalString(token.symbol));
    setIfDefined(tokenSummary, 'name', optionalString(token.name));
    setIfDefined(tokenSummary, 'decimals', optionalNumber(token.decimals));
    summary.token = tokenSummary;
  }
  setIfDefined(summary, 'proposalCount', optionalNumber(garden.proposalCount));
  setIfDefined(summary, 'supporterCount', optionalNumber(garden.supporterCount));
  setIfDefined(summary, 'honeyLiquidity', optionalString(garden.honeyLiquidity));
  setIfDefined(summary, 'active', optionalBoolean(garden.active) ?? optionalBoolean(config.active));
  return summary;
}

export function summarizeProposal(raw: unknown): GardenProposalSummary {
  const proposal = asRecord(raw);
  const summary: GardenProposalSummary = { id: optionalString(proposal.id) ?? '' };
  setIfDefined(summary, 'number', optionalString(proposal.number));
  setIfDefined(summary, 'title', truncateString(optionalString(proposal.metadata)));
  setIfDefined(summary, 'creator', optionalString(proposal.creator));
  setIfDefined(summary, 'beneficiary', optionalString(proposal.beneficiary));
  setIfDefined(summary, 'requestedAmount', optionalString(proposal.requestedAmount));
  setIfDefined(summary, 'status', optionalString(proposal.status));
  setIfDefined(summary, 'type', optionalString(proposal.type));
  setIfDefined(summary, 'metadataUri', optionalString(proposal.metadataUri));
  setIfDefined(summary, 'link', truncateString(optionalString(proposal.link)));
  setIfDefined(summary, 'createdAt', optionalString(proposal.createdAt));
  setIfDefined(summary, 'updatedAt', optionalString(proposal.updatedAt ?? proposal.executedAt));
  setIfDefined(summary, 'totalTokensStaked', optionalString(proposal.totalTokensStaked));
  setIfDefined(summary, 'stable', optionalBoolean(proposal.stable));
  return summary;
}

export function summarizeUser(raw: unknown): GardenUserSummary {
  const user = asRecord(raw);
  const supports = Array.isArray(user.supports) ? user.supports : [];
  const summary: GardenUserSummary = { id: optionalString(user.id) ?? '', supports: [] };
  setIfDefined(summary, 'address', optionalString(user.address) as HexAddress | undefined);
  setIfDefined(summary, 'gardensSigned', Array.isArray(user.gardensSigned) ? user.gardensSigned.map(String) : undefined);
  summary.supports = supports.map((support) => {
    const item = asRecord(support);
    const organization = asRecord(item.organization);
    const representative = asRecord(item.representative);
    const supportSummary: { id?: string; organization?: string; representative?: string } = {};
    setIfDefined(supportSummary, 'id', optionalString(item.id));
    setIfDefined(supportSummary, 'organization', optionalString(organization.id ?? item.organization));
    setIfDefined(supportSummary, 'representative', optionalString(representative.address ?? representative.id ?? item.representative));
    return supportSummary;
  });
  return summary;
}

const ORGANIZATIONS_QUERY = /* GraphQL */ `
  query Organizations($first: Int!, $skip: Int!, $orderBy: String!, $orderDirection: String!) {
    organizations(first: $first, where: { active: true }, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection) {
      id
      active
      createdAt
      proposalCount
      token { id symbol name decimals }
      honeyLiquidity
      supporterCount
    }
  }
`;

const USER_QUERY = /* GraphQL */ `
  query User($id: ID!) {
    user(id: $id) {
      id
      address
      gardensSigned
      supports {
        id
        organization { id }
        representative { id address }
      }
    }
  }
`;

const CONVICTION_CONFIG_QUERY = /* GraphQL */ `
  query ConvictionConfig($id: ID!) {
    config(id: $id) {
      id
      conviction {
        id
        decay
        weight
        maxRatio
        pctBase
        totalStaked
        minThresholdStakePercentage
      }
    }
  }
`;

function proposalsQuery(where: string, includeIndexMeta: boolean): string {
  return /* GraphQL */ `
    query Proposals($garden: String!, $first: Int!, $skip: Int!, $orderBy: Proposal_orderBy!, $orderDirection: OrderDirection!, $metadata: String!${where.includes('typeInt_in') ? ', $proposalTypes: [Int!]' : ''}${where.includes('statusInt_in') ? ', $statuses: [Int!]' : ''}) {
      ${includeIndexMeta ? '_meta { block { number } hasIndexingErrors }' : ''}
      proposals(where: { ${where} }, first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection) {
        id
        organization { id }
        number
        creator
        status
        type
        createdAt
        metadata
        executedAt
        link
        beneficiary
        requestedAmount
        totalTokensStaked
        stable
      }
    }
  `;
}

export async function listGardens(params: GardenListParams, deps: GardenConnectorDeps = {}): Promise<GardenReadResult<GardenSummary[]>> {
  const warnings: string[] = [];
  const { first, skip } = normalizePage(params.first, params.skip, warnings);
  const url = deps.subgraphUrl ?? requireGardensSubgraphUrl(params.network, warnings);
  const graphqlRequest = deps.graphqlRequest ?? defaultGraphqlRequest;
  const result = await graphqlRequest<{ organizations?: unknown[] }>(url, ORGANIZATIONS_QUERY, {
    first,
    skip,
    orderBy: params.orderBy ?? 'honeyLiquidity',
    orderDirection: 'desc'
  });

  return {
    data: (result.organizations ?? []).map((garden) => summarizeGarden(garden, params.network)),
    warnings
  };
}

export async function listGardenProposals(params: GardenProposalsParams, deps: GardenConnectorDeps = {}): Promise<GardenReadResult<GardenProposalSummary[]>> {
  const warnings: string[] = [];
  const { first, skip } = normalizePage(params.first, params.skip, warnings);
  const url = deps.subgraphUrl ?? requireGardensSubgraphUrl(params.network, warnings);
  const graphqlRequest = deps.graphqlRequest ?? defaultGraphqlRequest;
  const statuses = mapFilterValues(params.statuses, STATUS_TO_INT, 'status', warnings);
  const types = mapFilterValues(params.types, TYPE_TO_INT, 'type', warnings);
  const whereParts = ['organization: $garden', 'metadata_contains: $metadata'];
  const variables: Record<string, unknown> = {
    garden: params.dao.toLowerCase(),
    first,
    skip,
    orderBy: params.orderBy === 'staked' ? 'totalTokensStaked' : params.orderBy ?? 'createdAt',
    orderDirection: params.orderDirection ?? 'desc',
    metadata: ''
  };
  if (types) {
    whereParts.push('typeInt_in: $proposalTypes');
    variables.proposalTypes = types;
  }
  if (statuses) {
    whereParts.push('statusInt_in: $statuses');
    variables.statuses = statuses;
  }

  const result = await graphqlRequest<{ proposals?: unknown[]; _meta?: { block?: { number?: unknown }; hasIndexingErrors?: unknown } }>(
    url, proposalsQuery(whereParts.join(', '), deps.includeIndexMeta === true), variables
  );
  const indexBlock = result._meta?.block?.number;
  const indexingErrors = result._meta?.hasIndexingErrors;

  return {
    data: (result.proposals ?? []).map(summarizeProposal),
    ...(deps.includeIndexMeta && typeof indexBlock === 'number' && Number.isSafeInteger(indexBlock) && indexBlock >= 0 ? { indexBlock: String(indexBlock) } : {}),
    ...(deps.includeIndexMeta && typeof indexingErrors === 'boolean' ? { indexingErrors } : {}),
    warnings
  };
}

export async function lookupGardenUser(params: GardenUserParams, deps: GardenConnectorDeps = {}): Promise<GardenReadResult<GardenUserSummary | null>> {
  const warnings: string[] = [];
  const url = deps.subgraphUrl ?? requireGardensSubgraphUrl(params.network, warnings);
  const graphqlRequest = deps.graphqlRequest ?? defaultGraphqlRequest;
  const result = await graphqlRequest<{ user?: unknown | null }>(url, USER_QUERY, { id: params.address.toLowerCase() });
  const user = result.user ?? undefined;
  return {
    data: user ? summarizeUser(user) : null,
    warnings: user ? warnings : [...warnings, `No Gardens user found for ${params.address}.`]
  };
}

export async function readGardenConvictionConfig(params: { dao: string; network: ChainId }, deps: GardenConnectorDeps = {}): Promise<GardenReadResult<GardenConvictionConfig>> {
  const warnings: string[] = [];
  const url = deps.subgraphUrl ?? requireGardensSubgraphUrl(params.network, warnings);
  const graphqlRequest = deps.graphqlRequest ?? defaultGraphqlRequest;
  const result = await graphqlRequest<{ config?: { conviction?: unknown | null } | null }>(url, CONVICTION_CONFIG_QUERY, { id: params.dao.toLowerCase() });
  const conviction = asRecord(result.config?.conviction);
  const id = optionalString(conviction.id);
  const decay = optionalString(conviction.decay);
  const pctBase = optionalString(conviction.pctBase);
  if (!id || !decay || !pctBase) throw new Error(`No Gardens conviction config found for DAO ${params.dao}.`);
  const config: GardenConvictionConfig = { id, decay, pctBase };
  const weight = optionalString(conviction.weight);
  const maxRatio = optionalString(conviction.maxRatio);
  const totalStaked = optionalString(conviction.totalStaked);
  const minThresholdStakePercentage = optionalString(conviction.minThresholdStakePercentage);
  if (weight !== undefined) config.weight = weight;
  if (maxRatio !== undefined) config.maxRatio = maxRatio;
  if (totalStaked !== undefined) config.totalStaked = totalStaked;
  if (minThresholdStakePercentage !== undefined) config.minThresholdStakePercentage = minThresholdStakePercentage;
  return { data: config, warnings };
}
