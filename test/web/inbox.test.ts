import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { query } from '../../src/web/queries.js';
import { webServer } from '../../src/web/server.js';
import { actor, block, core, fixture, profile } from '../../examples/governance/fixture.js';
const local = { host: '127.0.0.1:8471', 'x-honey-read': '1' };

// Exercise the actual HTTP request listener without opening a network socket.
async function request(server: ReturnType<typeof webServer>, url: string) {
  const req = Object.assign(Readable.from([]), { url, method: 'GET', socket: { localPort: 8471 }, headers: local });
  let status = 0, raw = '';
  const res = Object.assign(new EventEmitter(), {
    writeHead(code: number) { status = code; return this; },
    end(data: string) { raw = String(data); }
  });
  await Reflect.apply(server.listeners('request')[0]!, server, [req, res]);
  return { status, json: () => JSON.parse(raw) };
}
function setup(options: Parameters<typeof fixture>[0] = {}, p = profile) {
  const deps = fixture(options);
  const server = webServer(p, q => query(p, q, deps), 'fixture');
  return { server, deps };
}

const outsider = '0x7777777777777777777777777777777777777777';
const path = (account: string, page = 1) => '/api/jury-inbox?account=' + account + '&page=' + page;

describe('read-only juror inbox', () => {
  it('reports only verified current-round seats from the same block', async () => {
    const { server, deps } = setup();
    const result = await request(server, path(actor));
    expect(result.status).toBe(200);
    expect(result.json()).toMatchObject({ coverage: 'page', scanned: 8, unknown: 0, hasNext: true, block: String(block),
      rows: [{ id: '21', kind: 'proposals', title: 'Orchard maintenance grant', period: 'vote', roundId: '0', status: 'vote-needed',
        seats: [{ voteId: '0', voted: false, choice: null }, { voteId: '2', voted: true, choice: '1' }] }] });
    const reads = deps.calls.filter(c => c.method === 'eth_call');
    expect(reads.length).toBeGreaterThan(8);
    expect([...new Set(reads.map(c => c.tag))]).toEqual(['0x' + block.toString(16)]);
    expect(deps.ballots).toHaveLength(0);
    expect((await request(server, path(actor, 2))).json()).toMatchObject({ rows: [], hasNext: false, coverage: 'page' });
  });
  it('separates no assignment from incomplete coverage and missing configuration', async () => {
    for (const [service, expected] of [
      [setup(), { coverage: 'page', unknown: 0 }], [setup({ badOwner: true }), { coverage: 'partial', unknown: 1 }],
      [setup({ failCore: true }), { coverage: 'partial', unknown: 1 }],
      [setup({}, { ...profile, adapter: undefined }), { coverage: 'no-adapter', scanned: 0 }],
      [setup({}, { ...profile, source: 'none' }), { coverage: 'no-list-source', scanned: 0 }]
    ] as const) {
      const response = await request(service.server, path(expected.coverage === 'page' ? outsider : actor));
      expect(response.json()).toMatchObject({ ...expected, rows: [] });
    }
  });
  it.each([{ hidden: true }, { paused: true }])('does not advertise a public vote for %j', async options => {
    const res = await request(setup(options).server, path(actor));
    expect(res.json()).toMatchObject({ rows: [{ status: 'unsupported' }] });
  });
  it.each([[0, 'waiting'], [1, 'unsupported'], [2, 'voted'], [3, 'appeal']] as const)(
    'labels period %s using the pinned Core and kit values', async (period, expected) => {
      const { server, deps } = setup();
      const original = deps.client.readContract.bind(deps.client);
      deps.client.readContract = async <T>(q: Parameters<typeof original>[0]): Promise<T> => {
        const result = await original<T>(q);
        if (q.address.toLowerCase() === core && q.functionName === 'disputes' && Array.isArray(result)) {
          expect(q.blockNumber).toBe(block);
          return [result[0], result[1], period, ...result.slice(3)] as T;
        }
        if (period === 2 && q.functionName === 'getVoteInfo' && Array.isArray(result)) {
          expect(q.blockNumber).toBe(block);
          return [result[0], result[1], 1n, true] as T;
        }
        return result;
      };
      expect((await request(server, path(actor))).json()).toMatchObject({ coverage: 'page', unknown: 0, rows: [{ status: expected }] });
    });
  it('rejects invalid or additional client-selected inputs before chain reads', async () => {
    const { server, deps } = setup();
    for (const query of ['', '?account=bad', '?account=' + actor + '&page=0', '?account=' + actor + '&page=1&page=2',
      '?account=' + actor + '&account=' + outsider, '?account=' + actor + '&roundId=1', '?account=' + actor + '&block=latest']) {
      expect((await request(server, '/api/jury-inbox' + query)).status).toBe(400);
    }
    expect(deps.calls).toHaveLength(0);
  });
});
