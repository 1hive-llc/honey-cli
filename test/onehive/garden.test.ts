import { describe, expect, it } from 'vitest';
import { listGardenProposals, listGardens, lookupGardenUser, normalizePage, resolveGardensSubgraphUrl, summarizeProposal } from '../../src/onehive/clients/garden.js';
import { gardenListTool, gardenProposalsTool, gardenUserTool } from '../../src/onehive/tools/garden.js';

describe('Gardens v1 client', () => {
  it('caps page size and normalizes skip', () => {
    const warnings: string[] = [];
    const page = normalizePage(100, -10, warnings);

    expect(page).toEqual({ first: 50, skip: 0 });
    expect(warnings[0]).toContain('Page size capped');
  });

  it('lists Garden summaries with mocked GraphQL response', async () => {
    const result = await listGardens(
      { network: 100, first: 99, skip: 0, orderBy: 'honeyLiquidity' },
      {
        subgraphUrl: 'https://subgraph.test/gardens',
        async graphqlRequest(url, query, variables) {
          expect(url).toBe('https://subgraph.test/gardens');
          expect(query).toContain('organizations');
          expect(variables).toMatchObject({ first: 50, skip: 0, orderBy: 'honeyLiquidity', orderDirection: 'desc' });
          return {
            organizations: [{
              id: '0xdao',
              token: { id: '0xtoken', symbol: 'HNY', name: 'Honey', decimals: 18 },
              proposalCount: 4,
              supporterCount: 8,
              honeyLiquidity: '12345',
              active: true
            }]
          } as never;
        }
      }
    );

    expect(result.data).toEqual([{ id: '0xdao', name: 'Honey', chainId: 100, dao: '0xdao', token: { id: '0xtoken', symbol: 'HNY', name: 'Honey', decimals: 18 }, proposalCount: 4, supporterCount: 8, honeyLiquidity: '12345', active: true }]);
    expect(result.warnings).toEqual(expect.arrayContaining(['Page size capped from 99 to 50.']));
  });

  it('fetches and summarizes Garden proposals through mocked GraphQL', async () => {
    const result = await listGardenProposals(
      {
        dao: '0xDAO',
        network: 100,
        first: 5,
        statuses: ['Active', 'bogus'],
        types: ['Proposal'],
        orderBy: 'staked',
        orderDirection: 'asc'
      },
      {
        subgraphUrl: 'https://subgraph.test/gardens',
        async graphqlRequest(url, query, variables) {
          expect(url).toBe('https://subgraph.test/gardens');
          expect(query).toContain('proposals');
          expect(query).toContain('typeInt_in');
          expect(query).toContain('statusInt_in');
          expect(variables).toMatchObject({ garden: '0xdao', first: 5, skip: 0, orderBy: 'totalTokensStaked', orderDirection: 'asc', statuses: [0], proposalTypes: [1], metadata: '' });
          return {
            proposals: [{
              id: 'proposal-1',
              number: '1',
              metadata: 'Fund useful public goods',
              creator: '0xcreator',
              beneficiary: '0xbeneficiary',
              requestedAmount: '1000000000000000000',
              status: 'Active',
              type: 'Proposal',
              createdAt: '1',
              totalTokensStaked: '42',
              stable: false
            }]
          } as never;
        }
      }
    );

    expect(result.data[0]).toMatchObject({ id: 'proposal-1', number: '1', title: 'Fund useful public goods', status: 'Active', type: 'Proposal' });
    expect(result.warnings).toEqual(expect.arrayContaining(['Ignored unknown Garden proposal status filter: bogus.']));
  });

  it('looks up and summarizes a Gardens user', async () => {
    const result = await lookupGardenUser(
      { network: 100, address: '0x1111111111111111111111111111111111111111' },
      {
        subgraphUrl: 'https://subgraph.test/gardens',
        async graphqlRequest(url, query, variables) {
          expect(url).toBe('https://subgraph.test/gardens');
          expect(query).toContain('user');
          expect(variables).toEqual({ id: '0x1111111111111111111111111111111111111111' });
          return {
            user: {
              id: 'user-1',
              address: '0x1111111111111111111111111111111111111111',
              gardensSigned: ['0xdao'],
              supports: [{ id: 'support-1', organization: { id: '0xdao' }, representative: { address: '0xrep' } }]
            }
          } as never;
        }
      }
    );

    expect(result.data).toMatchObject({ id: 'user-1', gardensSigned: ['0xdao'], supports: [{ id: 'support-1', organization: '0xdao', representative: '0xrep' }] });
  });

  it('builds a Graph gateway URL from THE_GRAPH_API_KEY when no direct subgraph URL is set', () => {
    const previousUrl = process.env.GARDENS_SUBGRAPH_URL;
    const previousGnosisUrl = process.env.GARDENS_GNOSIS_SUBGRAPH_URL;
    const previousGnosisId = process.env.GARDENS_GNOSIS_SUBGRAPH_ID;
    const previousKey = process.env.THE_GRAPH_API_KEY;

    try {
      delete process.env.GARDENS_SUBGRAPH_URL;
      delete process.env.GARDENS_GNOSIS_SUBGRAPH_URL;
      delete process.env.GARDENS_GNOSIS_SUBGRAPH_ID;
      process.env.THE_GRAPH_API_KEY = 'test-key';

      const result = resolveGardensSubgraphUrl(100);
      expect(result.data).toBe('https://gateway.thegraph.com/api/test-key/subgraphs/id/G4EbcSW588SUy8CdprPPxCN69VN8mxvnwt4oyR6YpGza');
      expect(result.warnings).toEqual([]);
    } finally {
      if (previousUrl === undefined) delete process.env.GARDENS_SUBGRAPH_URL;
      else process.env.GARDENS_SUBGRAPH_URL = previousUrl;
      if (previousGnosisUrl === undefined) delete process.env.GARDENS_GNOSIS_SUBGRAPH_URL;
      else process.env.GARDENS_GNOSIS_SUBGRAPH_URL = previousGnosisUrl;
      if (previousGnosisId === undefined) delete process.env.GARDENS_GNOSIS_SUBGRAPH_ID;
      else process.env.GARDENS_GNOSIS_SUBGRAPH_ID = previousGnosisId;
      if (previousKey === undefined) delete process.env.THE_GRAPH_API_KEY;
      else process.env.THE_GRAPH_API_KEY = previousKey;
    }
  });

  it('warns instead of falling back to legacy connector endpoints when no subgraph is configured', () => {
    const previousUrl = process.env.GARDENS_SUBGRAPH_URL;
    const previousGnosisUrl = process.env.GARDENS_GNOSIS_SUBGRAPH_URL;
    const previousGnosisId = process.env.GARDENS_GNOSIS_SUBGRAPH_ID;
    const previousKey = process.env.THE_GRAPH_API_KEY;
    const previousGraphKey = process.env.GRAPH_API_KEY;

    try {
      delete process.env.GARDENS_SUBGRAPH_URL;
      delete process.env.GARDENS_GNOSIS_SUBGRAPH_URL;
      process.env.GARDENS_GNOSIS_SUBGRAPH_ID = '';
      delete process.env.THE_GRAPH_API_KEY;
      delete process.env.GRAPH_API_KEY;

      const result = resolveGardensSubgraphUrl(100);
      expect(result.data).toBeUndefined();
      expect(result.warnings[0]).toContain('legacy @1hive/connect-gardens fallback has been removed');
    } finally {
      if (previousUrl === undefined) delete process.env.GARDENS_SUBGRAPH_URL;
      else process.env.GARDENS_SUBGRAPH_URL = previousUrl;
      if (previousGnosisUrl === undefined) delete process.env.GARDENS_GNOSIS_SUBGRAPH_URL;
      else process.env.GARDENS_GNOSIS_SUBGRAPH_URL = previousGnosisUrl;
      if (previousGnosisId === undefined) delete process.env.GARDENS_GNOSIS_SUBGRAPH_ID;
      else process.env.GARDENS_GNOSIS_SUBGRAPH_ID = previousGnosisId;
      if (previousKey === undefined) delete process.env.THE_GRAPH_API_KEY;
      else process.env.THE_GRAPH_API_KEY = previousKey;
      if (previousGraphKey === undefined) delete process.env.GRAPH_API_KEY;
      else process.env.GRAPH_API_KEY = previousGraphKey;
    }
  });

  it('truncates oversized proposal text fields', () => {
    const summary = summarizeProposal({ id: '1', metadata: 'x'.repeat(600), link: 'https://example.com/'.padEnd(650, 'a') });

    expect(summary.title?.length).toBeLessThan(520);
    expect(summary.title).toContain('[truncated]');
    expect(summary.link).toContain('[truncated]');
  });
});

describe('Gardens v1 tools', () => {
  it('exposes implemented tool definitions', () => {
    expect(gardenListTool.name).toBe('onehive_garden_list');
    expect(gardenProposalsTool.name).toBe('onehive_garden_proposals');
    expect(gardenUserTool.name).toBe('onehive_garden_user');
    expect(typeof gardenListTool.handler).toBe('function');
    expect(typeof gardenProposalsTool.handler).toBe('function');
    expect(typeof gardenUserTool.handler).toBe('function');
  });
});
