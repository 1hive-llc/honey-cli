import { describe, expect, it } from 'vitest';
import { CELESTE } from '../../src/onehive/addresses.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import { buildCourtAppealPreview, buildCourtClaimRewardsPreview, buildCourtCommitPreview, buildCourtHeartbeatPreview, buildCourtRevealPreview, buildCourtStakePreview, readCourtRewards, readCourtStatus, readCourtSubgraphStatus } from '../../src/onehive/tools/court.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';

function mockClient(overrides: Partial<ChainClient> = {}): ChainClient {
  return {
    chainId: 100,
    rpcUrl: 'mock',
    async getChainId() { return 100; },
    async getBytecode() { return '0x1234' as HexData; },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      if (request.functionName === 'getCurrentTermId') return 123n as T;
      if (request.functionName === 'getTermDuration') return 28800n as T;
      if (request.functionName === 'getNeededTermTransitions') return 3n as T;
      if (request.functionName === 'getVoting') return '0x00000000000000000000000000000000000000aa' as T;
      if (request.functionName === 'getDisputeManager') return '0x00000000000000000000000000000000000000bb' as T;
      if (request.functionName === 'isValidOutcome') return true as T;
      if (request.functionName === 'getDispute') return { lastRoundId: 2n } as T;
      if (request.functionName === 'getNextRoundDetails') return { feeToken: '0x00000000000000000000000000000000000000cc', appealDeposit: 10n, confirmAppealDeposit: 20n } as T;
      if (request.functionName === 'getJuror') return { weight: 3n, rewarded: false } as T;
      if (request.functionName === 'allowance') return 100n as T;
      throw new Error(`unexpected read ${request.functionName}`);
    },
    async simulateContract(_request: ContractSimulationRequest) { return { status: 'success' as const, gasEstimate: 12345n }; },
    async estimateGas() { return 12345n; },
    async call() { return '0x' as HexData; },
    ...overrides
  };
}

const TEST_SALT = '0x1111111111111111111111111111111111111111111111111111111111111111' as const;

describe('Honey court tools', () => {
  it('reads court term status and warns when heartbeat is needed', async () => {
    const result = await readCourtStatus({ chainId: 100, verifyCode: true }, { client: mockClient() });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      court: CELESTE.COURT,
      currentTermId: '123',
      termDuration: '28800',
      neededTermTransitions: '3',
      needsHeartbeat: true,
      hasCode: true
    });
    expect(result.warnings?.[0]).toContain('needs 3 term transition');
  });

  it('builds a simulated heartbeat preview capped to needed transitions', async () => {
    const result = await buildCourtHeartbeatPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', maxTransitions: 20 }, { client: mockClient() });

    expect(result.ok).toBe(true);
    const preview = result.data as TxPreview;
    expect(preview.to).toBe(CELESTE.COURT);
    expect(preview.decoded.method).toBe('heartbeat');
    expect(preview.decoded.args.maxTransitions).toBe('3');
    expect(preview.simulation.status).toBe('success');
    expect(preview.policy.checks.find((check) => check.name === 'allowlisted-target')?.status).toBe('pass');
  });

  it('refuses heartbeat previews when no transitions are needed', async () => {
    const client = mockClient({
      async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
        if (request.functionName === 'getNeededTermTransitions') return 0n as T;
        return 1n as T;
      }
    });
    const result = await buildCourtHeartbeatPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001' }, { client });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('heartbeat_not_needed');
  });

  it('builds commit previews against the court voting module with dynamic allowlist', async () => {
    const result = await buildCourtCommitPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', disputeId: '7', roundId: '0', outcome: '1', salt: TEST_SALT }, { client: mockClient() });

    expect(result.ok).toBe(true);
    const preview = result.data as TxPreview;
    expect(preview.to).toBe('0x00000000000000000000000000000000000000aa');
    expect(preview.decoded.method).toBe('commit');
    expect(preview.decoded.args.voteId).toBe((2n ** 128n * 7n).toString());
    expect(preview.decoded.args).not.toHaveProperty('password');
    expect(preview.policy.checks.find((check) => check.name === 'allowlisted-target')?.status).toBe('pass');
  });

  it('rejects password-derived keeper vote secrets', async () => {
    const result = await buildCourtCommitPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', disputeId: '7', roundId: '0', outcome: '1', password: 'secret' } as never, { client: mockClient() });

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('salt is required');
  });

  it('builds reveal previews against the court voting module', async () => {
    const result = await buildCourtRevealPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', disputeId: '7', roundId: '0', outcome: '1', salt: TEST_SALT }, { client: mockClient() });

    expect(result.ok).toBe(true);
    const preview = result.data as TxPreview;
    expect(preview.to).toBe('0x00000000000000000000000000000000000000aa');
    expect(preview.decoded.method).toBe('reveal');
    expect(preview.decoded.args.voteId).toBe((2n ** 128n * 7n).toString());
    expect(preview.decoded.args.outcome).toBe(1);
    expect(preview.policy.checks.find((check) => check.name === 'allowlisted-target')?.status).toBe('pass');
  });

  it('builds appeal previews against the court dispute manager', async () => {
    const result = await buildCourtAppealPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', disputeId: '7', ruling: '1' }, { client: mockClient() });

    expect(result.ok).toBe(true);
    const preview = result.data as TxPreview;
    expect(preview.to).toBe('0x00000000000000000000000000000000000000bb');
    expect(preview.decoded.method).toBe('createAppeal');
    expect(preview.decoded.args).toMatchObject({ disputeId: '7', roundId: '2', ruling: 1, deposit: '10' });
    expect(preview.policy.checks.find((check) => check.name === 'allowlisted-target')?.status).toBe('pass');
  });

  it('reads reward eligibility across dispute rounds', async () => {
    const result = await readCourtRewards({ chainId: 100, disputeId: '7', juror: '0x0000000000000000000000000000000000000001' }, { client: mockClient() });

    expect(result.ok).toBe(true);
    expect(result.data?.claimableRounds).toEqual(['0', '1', '2']);
    expect(result.data?.rounds[0]).toMatchObject({ roundId: '0', weight: '3', rewarded: false, claimable: true });
  });

  it('builds claim rewards previews against the court dispute manager', async () => {
    const result = await buildCourtClaimRewardsPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', disputeId: '7', roundId: '1' }, { client: mockClient() });

    expect(result.ok).toBe(true);
    const preview = result.data as TxPreview;
    expect(preview.to).toBe('0x00000000000000000000000000000000000000bb');
    expect(preview.decoded.method).toBe('settleReward');
    expect(preview.decoded.args).toMatchObject({ disputeId: '7', roundId: '1', juror: '0x0000000000000000000000000000000000000001', weight: '3' });
    expect(preview.policy.checks.find((check) => check.name === 'allowlisted-target')?.status).toBe('pass');
  });

  it('rejects appeal previews when fee-token allowance is missing', async () => {
    const client = mockClient({
      async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
        if (request.functionName === 'getChainId') return 100n as T;
        if (request.functionName === 'getDisputeManager') return '0x00000000000000000000000000000000000000bb' as T;
        if (request.functionName === 'getDispute') return { lastRoundId: 2n } as T;
        if (request.functionName === 'getNextRoundDetails') return { feeToken: '0x00000000000000000000000000000000000000cc', appealDeposit: 10n, confirmAppealDeposit: 20n } as T;
        if (request.functionName === 'allowance') return 0n as T;
        return 1n as T;
      }
    });
    const result = await buildCourtAppealPreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', disputeId: '7', ruling: '1' }, { client });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('missing_allowance');
  });

  it('rejects court stake previews when HNY registry allowance is missing', async () => {
    const client = mockClient({
      async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
        if (request.functionName === 'allowance') return 0n as T;
        if (request.functionName === 'getChainId') return 100n as T;
        return 1n as T;
      }
    });
    const result = await buildCourtStakePreview({ chainId: 100, from: '0x0000000000000000000000000000000000000001', amountHny: '100' }, { client });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('missing_allowance');
  });

  it('reports missing subgraph endpoints without failing RPC status', async () => {
    const previousKey = process.env.THE_GRAPH_API_KEY;
    const previousGraphKey = process.env.GRAPH_API_KEY;
    const previousCelesteUrl = process.env.CELESTE_SUBGRAPH_URL;
    const previousAgreementUrl = process.env.AGREEMENT_SUBGRAPH_URL;
    delete process.env.THE_GRAPH_API_KEY;
    delete process.env.GRAPH_API_KEY;
    delete process.env.CELESTE_SUBGRAPH_URL;
    delete process.env.AGREEMENT_SUBGRAPH_URL;
    try {
      const result = await readCourtSubgraphStatus({ chainId: 100 }, { client: mockClient() });

      expect(result.ok).toBe(true);
      expect(result.data?.rpcCurrentTermId).toBe('123');
      expect(result.data?.endpoints).toHaveLength(2);
      expect(result.data?.endpoints[0]).toMatchObject({ source: 'missing', urlConfigured: false });
      expect(result.warnings?.join('\n')).toContain('subgraph unhealthy');
    } finally {
      if (previousKey === undefined) delete process.env.THE_GRAPH_API_KEY; else process.env.THE_GRAPH_API_KEY = previousKey;
      if (previousGraphKey === undefined) delete process.env.GRAPH_API_KEY; else process.env.GRAPH_API_KEY = previousGraphKey;
      if (previousCelesteUrl === undefined) delete process.env.CELESTE_SUBGRAPH_URL; else process.env.CELESTE_SUBGRAPH_URL = previousCelesteUrl;
      if (previousAgreementUrl === undefined) delete process.env.AGREEMENT_SUBGRAPH_URL; else process.env.AGREEMENT_SUBGRAPH_URL = previousAgreementUrl;
    }
  });

  it('resolves Graph gateway deployment IDs from env', async () => {
    const previousKey = process.env.THE_GRAPH_API_KEY;
    const previousCeleste = process.env.CELESTE_SUBGRAPH_DEPLOYMENT_ID;
    const previousAgreement = process.env.AGREEMENT_SUBGRAPH_DEPLOYMENT_ID;
    process.env.THE_GRAPH_API_KEY = 'test-key';
    process.env.CELESTE_SUBGRAPH_DEPLOYMENT_ID = '0x0a0e39e376bf1e9a46c797368634bd886d15ec989039feb37a05e8448cdecb7d';
    process.env.AGREEMENT_SUBGRAPH_DEPLOYMENT_ID = '0x291048c4f6e5ad955e5382a4e111ff9bce87f38ea8a1f44de76ff956d50727a5';
    try {
      const seenUrls: string[] = [];
      const result = await readCourtSubgraphStatus({ chainId: 100 }, {
        client: mockClient(),
        now: new Date(1_000_000 * 1000),
        async graphRequest<T>(url: string): Promise<T> {
          seenUrls.push(url);
          if (url.includes('0x0a0e')) return { courtConfigs: [{ id: 'court', currentTerm: '123' }], disputes: [{ id: 'd1', createdAt: '999999' }] } as T;
          return { actions: [{ id: 'a1', createdAt: '999999' }] } as T;
        }
      });

      expect(result.ok).toBe(true);
      expect(seenUrls).toEqual(expect.arrayContaining([
        'https://gateway.thegraph.com/api/test-key/deployments/id/0x0a0e39e376bf1e9a46c797368634bd886d15ec989039feb37a05e8448cdecb7d',
        'https://gateway.thegraph.com/api/test-key/deployments/id/0x291048c4f6e5ad955e5382a4e111ff9bce87f38ea8a1f44de76ff956d50727a5'
      ]));
    } finally {
      if (previousKey === undefined) delete process.env.THE_GRAPH_API_KEY; else process.env.THE_GRAPH_API_KEY = previousKey;
      if (previousCeleste === undefined) delete process.env.CELESTE_SUBGRAPH_DEPLOYMENT_ID; else process.env.CELESTE_SUBGRAPH_DEPLOYMENT_ID = previousCeleste;
      if (previousAgreement === undefined) delete process.env.AGREEMENT_SUBGRAPH_DEPLOYMENT_ID; else process.env.AGREEMENT_SUBGRAPH_DEPLOYMENT_ID = previousAgreement;
    }
  });

  it('marks subgraph schemas degraded when expected freshness fields are missing', async () => {
    const result = await readCourtSubgraphStatus({ chainId: 100, celesteSubgraphUrl: 'https://example.test/celeste', agreementSubgraphUrl: 'https://example.test/agreement' }, {
      client: mockClient(),
      async graphRequest<T>(url: string): Promise<T> {
        if (url.includes('celeste')) return { courtConfigs: [{ id: 'court' }], disputes: [{ id: 'd1' }] } as T;
        return { actions: [{ id: 'a1' }] } as T;
      }
    });

    expect(result.ok).toBe(true);
    const celeste = result.data?.endpoints.find((endpoint) => endpoint.name === 'celeste');
    const agreement = result.data?.endpoints.find((endpoint) => endpoint.name === 'agreement');
    expect(celeste).toMatchObject({ ok: false, missingFields: ['courtConfigs.currentTerm', 'disputes.createdAt'] });
    expect(agreement).toMatchObject({ ok: false, missingFields: ['actions.createdAt'] });
    expect(result.warnings?.join('\n')).toContain('celeste subgraph unhealthy');
    expect(result.warnings?.join('\n')).toContain('agreement subgraph unhealthy');
  });

  it('checks subgraph endpoint freshness and term lag with redacted URLs', async () => {
    const result = await readCourtSubgraphStatus({ chainId: 100, celesteSubgraphUrl: 'https://gateway.thegraph.com/api/secret/subgraphs/id/celeste', agreementSubgraphUrl: 'https://example.test/agreement', maxIndexedAgeSeconds: 100 }, {
      client: mockClient(),
      now: new Date(1_000_000 * 1000),
      async graphRequest<T>(url: string): Promise<T> {
        if (url.includes('celeste')) return { courtConfigs: [{ id: 'court', currentTerm: '120' }], disputes: [{ id: 'd1', createdAt: '999800' }] } as T;
        return { actions: [{ id: 'a1', createdAt: '999950' }] } as T;
      }
    });

    expect(result.ok).toBe(true);
    const celeste = result.data?.endpoints.find((endpoint) => endpoint.name === 'celeste');
    const agreement = result.data?.endpoints.find((endpoint) => endpoint.name === 'agreement');
    expect(celeste).toMatchObject({ ok: true, source: 'cli', indexedCurrentTerm: '120', rpcCurrentTerm: '123', termLag: '3', stale: true, latestIndexedAgeSeconds: '200' });
    expect(celeste?.redactedUrl).toBe('https://gateway.thegraph.com/api/[REDACTED]/subgraphs/id/celeste');
    expect(agreement).toMatchObject({ ok: true, stale: false, latestIndexedAgeSeconds: '50' });
    expect(result.warnings?.join('\n')).toContain('lags RPC currentTerm 123 by 3 term');
    expect(result.warnings?.join('\n')).toContain('older than 100 second');
  });
});
