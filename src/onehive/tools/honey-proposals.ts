import { listGardenProposals, readGardenConvictionConfig, type GardenConvictionConfig, type GardenProposalSummary } from '../clients/garden.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import type { ToolDefinition } from '../tool-types.js';
import { ONEHIVE } from '../addresses.js';
import { fail, ok, type ChainId, type HexAddress, type OneHiveToolResult } from '../schemas.js';
import { readConvictionProposal, type ConvictionProposalState } from './governance.js';

export type HoneyProposalsListInput = {
  chainId?: ChainId;
  network?: ChainId;
  dao?: string;
  first?: number;
  limit?: number;
  skip?: number;
  statuses?: string[];
  types?: string[];
  orderBy?: 'createdAt' | 'updatedAt' | 'staked';
  orderDirection?: 'asc' | 'desc';
  crossCheckRpc?: boolean;
};

export type HoneyProposalForecastInput = {
  proposalId: string | number;
  chainId?: ChainId;
  network?: ChainId;
  dao?: string;
  averageBlockTimeSeconds?: number;
};

export type HoneyProposalCrossCheck = {
  checked: boolean;
  ok: boolean;
  proposalId?: string;
  rpc?: ConvictionProposalState;
  mismatches: Array<{ field: string; subgraph?: string; rpc?: string }>;
  error?: string;
  skippedReason?: string;
};

export type HoneyProposalSummary = GardenProposalSummary & {
  honeyContext: 'canonical-1hive';
  rpcCrossCheck?: HoneyProposalCrossCheck;
};

export type HoneyProposalsListOutput = {
  source: 'gardens-subgraph' | 'gardens-subgraph+rpc-cross-check';
  dao: string;
  chainId: ChainId;
  proposals: HoneyProposalSummary[];
  crossCheckSummary: { checked: number; passed: number; failed: number; errors: number };
};

export type HoneyProposalForecastOutput = {
  proposalId: string;
  chainId: ChainId;
  dao: string;
  currentBlock: string;
  blockLast: string;
  blocksSinceLast: string;
  stakedTokens: string;
  convictionLast: string;
  projectedCurrentConviction: string;
  threshold: string;
  eventualConviction: string;
  currentProgressBps: number;
  eventualProgressBps: number;
  willPassEventually: boolean;
  alreadyExecutable: boolean;
  estimatedPassBlock?: string;
  estimatedBlocksUntilPass?: string;
  estimatedSecondsUntilPass?: string;
  estimatedHoursUntilPass?: number;
  assumptions: string[];
  config: Pick<GardenConvictionConfig, 'decay' | 'pctBase'>;
};

type HoneyProposalDeps = {
  client?: ChainClient;
  listGardenProposals?: typeof listGardenProposals;
  readGardenConvictionConfig?: typeof readGardenConvictionConfig;
};

function chainFromInput(input: HoneyProposalsListInput): ChainId {
  return input.chainId ?? input.network ?? 100;
}

function normalizeFirst(input: HoneyProposalsListInput): number | undefined {
  return input.first ?? input.limit;
}

function lower(value: string | undefined): string | undefined {
  return value?.toLowerCase();
}

function addMismatch(mismatches: HoneyProposalCrossCheck['mismatches'], field: string, subgraph: unknown, rpc: unknown): void {
  if (subgraph === undefined || rpc === undefined) return;
  const subgraphValue = String(subgraph);
  const rpcValue = String(rpc);
  if (subgraphValue !== rpcValue) mismatches.push({ field, subgraph: subgraphValue, rpc: rpcValue });
}

function compareProposal(proposal: GardenProposalSummary, rpc: ConvictionProposalState): HoneyProposalCrossCheck {
  const mismatches: HoneyProposalCrossCheck['mismatches'] = [];
  addMismatch(mismatches, 'status', proposal.status, rpc.status);
  addMismatch(mismatches, 'requestedAmount', proposal.requestedAmount, rpc.requestedAmount);
  addMismatch(mismatches, 'totalTokensStaked', proposal.totalTokensStaked, rpc.stakedTokens);
  addMismatch(mismatches, 'stable', proposal.stable, rpc.stableRequestAmount);
  const subgraphBeneficiary = lower(proposal.beneficiary);
  const rpcBeneficiary = lower(rpc.beneficiary);
  if (subgraphBeneficiary !== undefined && rpcBeneficiary !== undefined && subgraphBeneficiary !== rpcBeneficiary) {
    mismatches.push({ field: 'beneficiary', subgraph: proposal.beneficiary ?? subgraphBeneficiary, rpc: rpc.beneficiary });
  }
  return { checked: true, ok: mismatches.length === 0, proposalId: rpc.proposalId, rpc, mismatches };
}

function isConvictionProposalType(proposal: GardenProposalSummary): boolean {
  const type = proposal.type?.trim().toLowerCase();
  return type === undefined || type === 'proposal' || type === 'suggestion';
}

async function crossCheckProposal(proposal: GardenProposalSummary, chainId: ChainId, client: ChainClient): Promise<HoneyProposalCrossCheck> {
  if (!isConvictionProposalType(proposal)) {
    const skipped: HoneyProposalCrossCheck = { checked: false, ok: true, mismatches: [], skippedReason: `RPC getProposal cross-check skipped for non-Conviction record type: ${proposal.type ?? 'unknown'}.` };
    if (proposal.number !== undefined) skipped.proposalId = proposal.number;
    return skipped;
  }
  const proposalId = proposal.number;
  if (!proposalId || !/^\d+$/.test(proposalId)) {
    return { checked: false, ok: false, mismatches: [], error: 'Subgraph proposal did not include a numeric proposal number for RPC getProposal cross-check.' };
  }
  try {
    const rpc = await readConvictionProposal({ proposalId, chainId }, client);
    return compareProposal(proposal, rpc);
  } catch (error) {
    return { checked: false, ok: false, proposalId, mismatches: [], error: error instanceof Error ? error.message : 'RPC proposal cross-check failed.' };
  }
}

function formatTokenAmount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return value.toFixed(6).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

function calculateForecast(params: { proposal: ConvictionProposalState; config: GardenConvictionConfig; currentBlock: bigint; averageBlockTimeSeconds: number; chainId: ChainId; dao: string }): HoneyProposalForecastOutput {
  const staked = Number(BigInt(params.proposal.stakedTokens)) / 1e18;
  const convictionLast = Number(BigInt(params.proposal.convictionLast)) / 1e18;
  const threshold = Number(BigInt(params.proposal.threshold)) / 1e18;
  const blockLast = BigInt(params.proposal.blockLast);
  const blocksSinceLast = params.currentBlock > blockLast ? params.currentBlock - blockLast : 0n;
  const decay = Number(params.config.decay);
  const pctBase = Number(params.config.pctBase);
  const alpha = decay / pctBase;
  const eventualConviction = alpha > 0 && alpha < 1 ? staked / (1 - alpha) : staked;
  const projectedCurrentConviction = eventualConviction - (eventualConviction - convictionLast) * Math.pow(alpha, Number(blocksSinceLast));
  const currentProgressBps = threshold > 0 ? Math.floor(projectedCurrentConviction / threshold * 10_000) : 10_000;
  const eventualProgressBps = threshold > 0 ? Math.floor(eventualConviction / threshold * 10_000) : 10_000;
  const willPassEventually = threshold === 0 || eventualConviction >= threshold;
  const alreadyExecutable = params.proposal.open && !params.proposal.executed && (threshold === 0 || projectedCurrentConviction >= threshold);
  const output: HoneyProposalForecastOutput = {
    proposalId: params.proposal.proposalId,
    chainId: params.chainId,
    dao: params.dao,
    currentBlock: params.currentBlock.toString(),
    blockLast: blockLast.toString(),
    blocksSinceLast: blocksSinceLast.toString(),
    stakedTokens: formatTokenAmount(staked),
    convictionLast: formatTokenAmount(convictionLast),
    projectedCurrentConviction: formatTokenAmount(projectedCurrentConviction),
    threshold: formatTokenAmount(threshold),
    eventualConviction: formatTokenAmount(eventualConviction),
    currentProgressBps,
    eventualProgressBps,
    willPassEventually,
    alreadyExecutable,
    assumptions: [
      'Assumes current staked support remains unchanged.',
      `Assumes average block time of ${params.averageBlockTimeSeconds} seconds for wall-clock estimates.`,
      'Projection uses Gardens subgraph conviction decay/pctBase config and latest RPC proposal state.'
    ],
    config: { decay: params.config.decay, pctBase: params.config.pctBase }
  };
  if (willPassEventually && !alreadyExecutable && threshold > 0 && eventualConviction > threshold && convictionLast < threshold) {
    const numerator = (eventualConviction - threshold) / (eventualConviction - convictionLast);
    if (numerator > 0 && numerator < 1 && alpha > 0 && alpha < 1) {
      const blocksFromLast = Math.log(numerator) / Math.log(alpha);
      const remainingBlocks = Math.max(0, Math.ceil(blocksFromLast - Number(blocksSinceLast)));
      output.estimatedPassBlock = (blockLast + BigInt(Math.ceil(blocksFromLast))).toString();
      output.estimatedBlocksUntilPass = String(remainingBlocks);
      output.estimatedSecondsUntilPass = String(Math.ceil(remainingBlocks * params.averageBlockTimeSeconds));
      output.estimatedHoursUntilPass = Math.round(remainingBlocks * params.averageBlockTimeSeconds / 36) / 100;
    }
  }
  return output;
}

export async function forecastHoneyProposal(input: HoneyProposalForecastInput, deps: HoneyProposalDeps = {}): Promise<OneHiveToolResult<HoneyProposalForecastOutput>> {
  try {
    const chainId = chainFromInput(input);
    const dao = input.dao ?? ONEHIVE.DAO_KERNEL;
    const averageBlockTimeSeconds = input.averageBlockTimeSeconds ?? 5;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const configReader = deps.readGardenConvictionConfig ?? readGardenConvictionConfig;
    const proposal = await readConvictionProposal({ proposalId: input.proposalId, chainId }, client);
    const config = await configReader({ dao, network: chainId });
    const currentBlock = client.getBlockNumber ? await client.getBlockNumber() : BigInt(proposal.blockLast);
    const forecast = calculateForecast({ proposal, config: config.data, currentBlock, averageBlockTimeSeconds, chainId, dao });
    return ok(forecast, config.warnings);
  } catch (error) {
    return fail('honey_proposal_forecast_failed', error instanceof Error ? error.message : 'Failed to forecast Honey proposal.', undefined, true);
  }
}

export async function listHoneyProposals(input: HoneyProposalsListInput, deps: HoneyProposalDeps = {}): Promise<OneHiveToolResult<HoneyProposalsListOutput>> {
  try {
    const chainId = chainFromInput(input);
    const dao = input.dao ?? ONEHIVE.DAO_KERNEL;
    const warnings: string[] = [];
    const listFn = deps.listGardenProposals ?? listGardenProposals;
    const listParams: Parameters<typeof listGardenProposals>[0] = { dao, network: chainId };
    const first = normalizeFirst(input);
    if (first !== undefined) listParams.first = first;
    if (input.skip !== undefined) listParams.skip = input.skip;
    if (input.statuses !== undefined) listParams.statuses = input.statuses;
    listParams.types = input.types ?? ['proposal'];
    if (input.orderBy !== undefined) listParams.orderBy = input.orderBy;
    if (input.orderDirection !== undefined) listParams.orderDirection = input.orderDirection;
    const subgraph = await listFn(listParams);
    warnings.push(...subgraph.warnings);

    const shouldCrossCheck = input.crossCheckRpc !== false;
    const client = deps.client ?? (shouldCrossCheck ? createChainClientFromEnv(chainId) : undefined);
    const proposals: HoneyProposalSummary[] = [];
    const crossCheckSummary = { checked: 0, passed: 0, failed: 0, errors: 0 };

    for (const proposal of subgraph.data) {
      const summary: HoneyProposalSummary = { ...proposal, honeyContext: 'canonical-1hive' };
      if (shouldCrossCheck && client) {
        const check = await crossCheckProposal(proposal, chainId, client);
        summary.rpcCrossCheck = check;
        if (check.checked) {
          crossCheckSummary.checked += 1;
          if (check.ok) crossCheckSummary.passed += 1;
          else if (check.error) crossCheckSummary.errors += 1;
          else crossCheckSummary.failed += 1;
        }
        if (!check.ok) warnings.push(`RPC cross-check ${check.error ? 'error' : 'mismatch'} for Honey proposal ${proposal.number ?? proposal.id}${check.error ? `: ${check.error}` : ''}.`);
      }
      proposals.push(summary);
    }

    return ok({ source: shouldCrossCheck ? 'gardens-subgraph+rpc-cross-check' : 'gardens-subgraph', dao, chainId, proposals, crossCheckSummary }, warnings);
  } catch (error) {
    return fail('honey_proposals_list_failed', error instanceof Error ? error.message : 'Failed to list Honey proposals.', undefined, true);
  }
}

export const honeyProposalForecastTool: ToolDefinition<HoneyProposalForecastInput, HoneyProposalForecastOutput> = {
  name: 'onehive_honey_proposal_forecast',
  description: 'Forecast whether a Honey Conviction Voting proposal will pass with current support.',
  inputSchema: {
    type: 'object',
    required: ['proposalId'],
    additionalProperties: false,
    properties: {
      proposalId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
      chainId: { enum: [100, 10200, 31337] },
      network: { enum: [100, 10200, 31337] },
      dao: { type: 'string' },
      averageBlockTimeSeconds: { type: 'number', minimum: 1 }
    }
  },
  handler: forecastHoneyProposal
};

export const honeyProposalsListTool: ToolDefinition<HoneyProposalsListInput, HoneyProposalsListOutput> = {
  name: 'onehive_honey_proposals_list',
  description: 'List canonical Honey/1Hive proposals from the Gardens subgraph and cross-check each proposal against RPC getProposal state by default.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      chainId: { enum: [100, 10200, 31337] },
      network: { enum: [100, 10200, 31337] },
      dao: { type: 'string' },
      first: { type: 'number', minimum: 1, maximum: 50 },
      limit: { type: 'number', minimum: 1, maximum: 50 },
      skip: { type: 'number', minimum: 0 },
      statuses: { type: 'array', items: { type: 'string' } },
      types: { type: 'array', items: { type: 'string' } },
      orderBy: { enum: ['createdAt', 'updatedAt', 'staked'] },
      orderDirection: { enum: ['asc', 'desc'] },
      crossCheckRpc: { type: 'boolean' }
    }
  },
  handler: listHoneyProposals
};
