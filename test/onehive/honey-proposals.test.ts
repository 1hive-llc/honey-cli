import { describe, expect, it } from 'vitest';
import type { ChainClient, ContractReadRequest } from '../../src/onehive/clients/chain.js';
import type { GardenProposalSummary } from '../../src/onehive/clients/garden.js';
import type { HexData } from '../../src/onehive/schemas.js';
import { forecastHoneyProposal, listHoneyProposals } from '../../src/onehive/tools/honey-proposals.js';

function mockClient(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    chainId: 100,
    rpcUrl: 'mock',
    async getChainId() { return 100; },
    async getBlockNumber() { return 1100n; },
    async getBytecode() { return '0x1234' as HexData; },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      if (request.functionName === 'getProposal') {
        return [
          1000n,
          false,
          '0x00000000000000000000000000000000000000be',
          500n,
          0n,
          1n,
          9n,
          0,
          '0x00000000000000000000000000000000000000ca',
          10n
        ] as T;
      }
      throw new Error(`unexpected read ${request.functionName}`);
    },
    async simulateContract() { return { status: 'success' as const }; },
    async estimateGas() { return 1n; },
    ...overrides
  };
}

const matchingProposal: GardenProposalSummary = {
  id: 'appAddress:0x0b-proposalId:0xd5',
  number: '213',
  title: 'Honey funding',
  beneficiary: '0x00000000000000000000000000000000000000BE',
  requestedAmount: '1000',
  totalTokensStaked: '500',
  status: 'Active',
  type: 'Proposal',
  stable: false
};

describe('Honey proposal list cross-checking', () => {
  it('lists Honey proposals and attaches successful RPC cross-checks', async () => {
    const result = await listHoneyProposals({ chainId: 100, first: 1 }, {
      client: mockClient(),
      async listGardenProposals() { return { data: [matchingProposal], warnings: [] }; }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.source).toBe('gardens-subgraph+rpc-cross-check');
    expect(result.data?.crossCheckSummary).toMatchObject({ checked: 1, passed: 1, failed: 0, errors: 0 });
    expect(result.data?.proposals[0]?.rpcCrossCheck?.ok).toBe(true);
    expect(result.data?.proposals[0]?.rpcCrossCheck?.rpc?.proposalId).toBe('213');
  });

  it('reports mismatches between subgraph proposal summaries and RPC state', async () => {
    const result = await listHoneyProposals({ chainId: 100, first: 1 }, {
      client: mockClient(),
      async listGardenProposals() { return { data: [{ ...matchingProposal, status: 'Executed', totalTokensStaked: '499' }], warnings: [] }; }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.crossCheckSummary).toMatchObject({ checked: 1, passed: 0, failed: 1, errors: 0 });
    expect(result.data?.proposals[0]?.rpcCrossCheck?.mismatches.map((entry) => entry.field)).toEqual(['status', 'totalTokensStaked']);
    expect(result.warnings?.join('\n')).toContain('RPC cross-check mismatch');
  });

  it('defaults to Conviction funding proposals rather than Decision records', async () => {
    const result = await listHoneyProposals({ chainId: 100, first: 1 }, {
      client: mockClient(),
      async listGardenProposals(params) {
        expect(params.types).toEqual(['proposal']);
        return { data: [matchingProposal], warnings: [] };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.crossCheckSummary).toMatchObject({ checked: 1, passed: 1 });
  });

  it('skips Conviction RPC cross-checks for explicitly requested Decision records', async () => {
    const result = await listHoneyProposals({ chainId: 100, first: 1, types: ['decision'] }, {
      client: mockClient({
        async readContract() { throw new Error('Decision records must not call Conviction getProposal'); }
      }),
      async listGardenProposals(params) {
        expect(params.types).toEqual(['decision']);
        return { data: [{ ...matchingProposal, type: 'Decision', number: '20' }], warnings: [] };
      }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.crossCheckSummary).toMatchObject({ checked: 0, passed: 0, failed: 0, errors: 0 });
    expect(result.data?.proposals[0]?.rpcCrossCheck).toMatchObject({ checked: false, ok: true, skippedReason: expect.stringContaining('non-Conviction') });
    expect(result.warnings).toEqual([]);
  });

  it('can list from the subgraph without RPC cross-checking', async () => {
    const result = await listHoneyProposals({ chainId: 100, first: 1, crossCheckRpc: false }, {
      async listGardenProposals() { return { data: [matchingProposal], warnings: ['subgraph warning'] }; }
    });

    expect(result.ok).toBe(true);
    expect(result.data?.source).toBe('gardens-subgraph');
    expect(result.data?.proposals[0]?.rpcCrossCheck).toBeUndefined();
    expect(result.warnings).toEqual(['subgraph warning']);
  });

  it('forecasts whether current support will eventually pass a Conviction proposal', async () => {
    const scale = 10n ** 18n;
    const result = await forecastHoneyProposal({ chainId: 100, proposalId: 213, averageBlockTimeSeconds: 5 }, {
      client: mockClient({
        async getBlockNumber() { return 1001n; },
        async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
          if (request.functionName === 'getProposal') {
            return [
              1000n * scale,
              false,
              '0x00000000000000000000000000000000000000be',
              500n * scale,
              0n,
              1000n,
              9n,
              0,
              '0x00000000000000000000000000000000000000ca',
              900n * scale
            ] as T;
          }
          throw new Error(`unexpected read ${request.functionName}`);
        }
      }),
      async readGardenConvictionConfig() { return { data: { id: 'config', decay: '50', pctBase: '100' }, warnings: [] }; }
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ willPassEventually: true, alreadyExecutable: false, eventualProgressBps: 11111 });
    expect(Number(result.data?.estimatedBlocksUntilPass)).toBeGreaterThan(0);
  });
});
