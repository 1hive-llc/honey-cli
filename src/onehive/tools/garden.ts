import { listGardenProposals, listGardens, lookupGardenUser, type GardenProposalSummary, type GardenSummary, type GardenUserSummary } from '../clients/garden.js';
import type { ToolDefinition } from '../tool-types.js';
import { addressPattern, fail, ok, type ChainId, type HexAddress } from '../schemas.js';

export type GardenListInput = {
  network: ChainId;
  first?: number;
  skip?: number;
  orderBy?: 'honeyLiquidity' | 'createdAt' | 'name';
};

export type GardenProposalsInput = {
  dao: string;
  network: ChainId;
  first?: number;
  skip?: number;
  statuses?: string[];
  types?: string[];
  orderBy?: 'createdAt' | 'updatedAt' | 'staked';
  orderDirection?: 'asc' | 'desc';
};

export type GardenUserInput = {
  address: HexAddress;
  network: ChainId;
};

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Unknown Gardens subgraph error.';
  return message
    .replace(/https:\/\/gateway\.thegraph\.com\/api\/[^/\s]+/g, 'https://gateway.thegraph.com/api/[REDACTED]')
    .replace(/(THE_GRAPH_API_KEY|GRAPH_API_KEY)=([^\s]+)/g, '$1=[REDACTED]');
}

export const gardenListTool: ToolDefinition<GardenListInput, GardenSummary[]> = {
  name: 'onehive_garden_list',
  description: 'List Gardens v1 Garden summaries through direct Gardens subgraph GraphQL reads.',
  inputSchema: {
    type: 'object',
    required: ['network'],
    additionalProperties: false,
    properties: {
      network: { enum: [100, 10200, 31337] },
      first: { type: 'number', minimum: 1, maximum: 50 },
      skip: { type: 'number', minimum: 0 },
      orderBy: { enum: ['honeyLiquidity', 'createdAt', 'name'] }
    }
  },
  async handler(input) {
    try {
      const result = await listGardens(input);
      return ok(result.data, result.warnings);
    } catch (error) {
      return fail('gardens_list_failed', `Failed to list Gardens: ${errorMessage(error)}`, undefined, true);
    }
  }
};

export const gardenProposalsTool: ToolDefinition<GardenProposalsInput, GardenProposalSummary[]> = {
  name: 'onehive_garden_proposals',
  description: 'Fetch Gardens v1 proposals for a Garden DAO.',
  inputSchema: {
    type: 'object',
    required: ['dao', 'network'],
    additionalProperties: false,
    properties: {
      dao: { type: 'string' },
      network: { enum: [100, 10200, 31337] },
      first: { type: 'number', minimum: 1, maximum: 50 },
      skip: { type: 'number', minimum: 0 },
      statuses: { type: 'array', items: { type: 'string' } },
      types: { type: 'array', items: { type: 'string' } },
      orderBy: { enum: ['createdAt', 'updatedAt', 'staked'] },
      orderDirection: { enum: ['asc', 'desc'] }
    }
  },
  async handler(input) {
    try {
      const result = await listGardenProposals(input);
      return ok(result.data, result.warnings);
    } catch (error) {
      return fail('garden_proposals_failed', `Failed to fetch Garden proposals: ${errorMessage(error)}`, undefined, true);
    }
  }
};

export const gardenUserTool: ToolDefinition<GardenUserInput, GardenUserSummary | null> = {
  name: 'onehive_garden_user',
  description: 'Lookup a Gardens v1 user by wallet address.',
  inputSchema: {
    type: 'object',
    required: ['address', 'network'],
    additionalProperties: false,
    properties: {
      address: { type: 'string', pattern: addressPattern },
      network: { enum: [100, 10200, 31337] }
    }
  },
  async handler(input) {
    try {
      const result = await lookupGardenUser(input);
      return ok(result.data, result.warnings);
    } catch (error) {
      return fail('garden_user_failed', `Failed to lookup Gardens user: ${errorMessage(error)}`, undefined, true);
    }
  }
};
