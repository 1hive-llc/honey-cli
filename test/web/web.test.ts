import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runHoneyCli } from '../../src/honey-cli.js';
import * as chain from '../../src/onehive/clients/chain.js';
import { ONEHIVE } from '../../src/onehive/addresses.js';
import { parseProfile } from '../../src/web/profile.js';
import { liveDependencies, query } from '../../src/web/queries.js';
import { webServer, workerRunner } from '../../src/web/server.js';
import { actor, adapter, block, core, dispute, fixture, kit, profile } from '../../examples/governance/fixture.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const casePage = { op: 'list', area: 'cases', page: 1 } as const;
const preview = { from: actor, beneficiary: actor, title: 'Fixture grant', link: 'ipfs://fixture', amount: '1.5', stable: true };
const origin = 'http://127.0.0.1:8471';
const local = { host: '127.0.0.1:8471', 'x-honey-read': '1' };

// Exercise the actual HTTP request listener without opening a network socket.
async function request(server: ReturnType<typeof webServer>, url: string,
  options: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  const body = options.body ?? '';
  const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), {
    url, method: options.method ?? 'GET', socket: { localPort: 8471 },
    headers: { ...local, ...(body ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)), origin } : {}), ...options.headers }
  });
  let status = 0, raw = '', headers: Record<string, string> = {};
  const res = Object.assign(new EventEmitter(), {
    writeHead(s: number, h: typeof headers) { status = s; headers = h; return this; },
    end(data: Buffer | string) { raw = String(data); }
  });
  await Reflect.apply(server.listeners('request')[0]!, server, [req, res]);
  return { status, headers, raw, json: () => JSON.parse(raw) };
}
function setup(options: Parameters<typeof fixture>[0] = {}, p = profile) {
  const deps = fixture(options);
  const server = webServer(p, q => query(p, q, deps), 'fixture');
  return { server, deps };
}
async function cli(args: string[]) {
  let out = '', err = '';
  const exit = await runHoneyCli([...args, '--chain', '31337', '--json'], {
    stdout: { write(s: string) { out += s; return true; } }, stderr: { write(s: string) { err += s; return true; } }
  });
  expect([exit, err]).toEqual([0, '']);
  return JSON.parse(out).data;
}

describe('Honey web query contract', () => {
  it('matches the CLI proposal and Agreement/Core case at the same pinned synthetic block', async () => {
    const { deps, server } = setup();
    const ui = (await request(server, '/api/proposals/21')).json();
    const cases = (await request(server, '/api/cases')).json();
    // CLI proposals show reads latest. Give that command a pinned client for an exact comparison.
    const pinned: chain.ChainClient = { ...deps.client, readContract: req => deps.client.readContract({ ...req, blockNumber: block }) };
    vi.spyOn(chain, 'createChainClientFromEnv').mockReturnValue(pinned);
    const app = await cli(['proposals', 'show', '21']);
    const court = await cli(['disputes', 'status', '--proposal', '21', '--adapter', adapter]);
    expect(ui.data).toEqual(app);
    expect(ui).toMatchObject({ mode: 'fixture', chainId: 31337, block: String(block), app: ONEHIVE.CONVICTION_VOTING });
    expect(court.blockNumber).toBe(ui.block);
    expect(cases).toMatchObject({ block: ui.block, coverage: 'page', unknown: 0, scanned: 8, hasNext: true });
    const a = court.action, ch = a.latestChallenge;
    expect(ui.court).toMatchObject({ state: 'Active Kleros case', actionId: a.actionId, setting: a.setting.settingId,
      arbitrator: a.setting.arbitrator, challenge: ch.challengeId, dispute: ch.disputeId, core: ch.court.core,
      coreDispute: ch.court.coreDisputeId, courtId: ch.court.currentCourtId, period: ch.court.period,
      adapterFinalised: ch.court.finalised, coreRuled: ch.court.coreRuled });
    expect(cases.rows).toEqual([{ id: '21', kind: 'proposals', title: 'Orchard maintenance grant', state: 'Active Kleros case', court: ui.court }]);
    expect(ui.court).toMatchObject({ actionId: '121', challenge: '7', dispute: String(dispute), core, coreDispute: '0', courtId: '5', period: 'vote' });
    const calls = deps.calls.filter(c => c.method === 'eth_call');
    expect(calls.length).toBeGreaterThan(10);
    expect(new Set(calls.map(c => c.tag))).toEqual(new Set(['0x' + block.toString(16)]));
  });

  it('paginates the app-specific index, filters across pages, and reads Decision vote zero', async () => {
    const { server } = setup();
    const first = (await request(server, '/api/proposals')).json();
    const second = (await request(server, '/api/proposals?page=2')).json();
    expect(first.rows).toHaveLength(8);
    expect(first.block).toBeNull();
    expect(first.hasNext).toBe(true);
    expect(second.rows.map((r: {id: string}) => r.id)).toEqual(['13']);
    expect(second.hasNext).toBe(false);
    const filtered = (await request(server, '/api/proposals?state=executed')).json();
    expect(filtered.rows.map((r: {id: string}) => r.id)).toEqual(['19', '15', '14']);
    const votes = (await request(server, '/api/votes')).json();
    expect(votes.rows).toHaveLength(1);
    expect(votes.rows[0].id).toBe('0');
    expect((await request(server, '/api/votes/0')).json()).toMatchObject({ block: String(block),
      data: { voteId: '0', yea: '300', nay: '50', isOpenForVoting: true }, court: { state: 'No challenge' } });
  });

  it('distinguishes a completed empty scan, a missing index/adapter, partial reads, and a failed index', async () => {
    const req = async (s: ReturnType<typeof webServer>) => (await request(s, '/api/cases')).json();
    expect(await req(setup({ noCases: true }).server)).toMatchObject({ coverage: 'page', scanned: 8, unknown: 0, rows: [], block: String(block) });
    expect(await req(setup({ empty: true }).server)).toMatchObject({ coverage: 'page', scanned: 0, rows: [], block: null });
    expect(await req(setup({}, { ...profile, adapter: undefined }).server)).toMatchObject({ coverage: 'no-adapter', scanned: 0 });
    expect(await req(setup({}, { ...profile, source: 'none' }).server)).toMatchObject({ coverage: 'no-list-source' });
    expect(await req(setup({ failCore: true }).server)).toMatchObject({ coverage: 'partial', unknown: 1, rows: [{ state: 'Unknown' }] });
    expect(await req(setup({ linked: false }).server)).toMatchObject({ coverage: 'partial', scanned: 8, unknown: 8 });
    expect(await req(setup({ ruled: true }).server)).toMatchObject({ rows: [{ state: 'Awaiting Agreement resolution' }] });
    const failed = await request(setup({ badIndex: true }).server, '/api/cases');
    expect(failed.status).toBe(502);
    expect(failed.raw).not.toContain('private-marker');
    expect(failed.json()).not.toHaveProperty('rows');
    const wrong = setup({ chain: 100 });
    expect((await request(wrong.server, '/api/cases')).json().error.code).toBe('wrong-chain');
    expect(wrong.deps.calls.map(c => c.method)).toEqual(['eth_chainId']);
  });

  it('reports malformed index candidates without inventing app IDs or counting them as negative observations', async () => {
    const deps = fixture();
    const res = await query(profile, casePage, { ...deps, index: async () => ({ data: [
      { id: 'arbitrary', number: '999', type: 'Stream' }, { id: 'untyped', type: 'Proposal' }
    ], warnings: [] }) });
    expect(res).toMatchObject({ coverage: 'partial', unknown: 2, scanned: 2, rows: [], block: null });
    expect(deps.calls).toEqual([]);
  });

  it('marks an otherwise empty page partial when the index reports indexing errors', async () => {
    const deps = fixture();
    const result = await query(profile, casePage, { ...deps, index: async () => ({
      data: [], warnings: [], indexBlock: '900', indexingErrors: true
    }) });
    expect(result).toMatchObject({ coverage: 'partial', scanned: 0, unknown: 0, rows: [], indexBlock: '900', indexingErrors: true });
    expect(deps.calls).toEqual([]);
  });

  it('reads operator-specified IDs without an index, including partial records', async () => {
    const p = parseProfile({ HONEY_WEB_CHAIN_ID: '31337', FORK_RPC_URL: profile.rpcUrl, HONEY_WEB_PROPOSALS: '21,999', HONEY_WEB_VOTES: '0' });
    const deps = fixture({ badIndex: true });
    expect(await query(p, { op: 'list', area: 'proposals', page: 1 }, deps)).toMatchObject({ block: String(block),
      coverage: 'partial', unknown: 1, rows: [{ id: '21', state: 'Paused' }, { id: '999', state: 'Unknown' }] });
  });

  it('uses the production Gardens query and production viem client against an in-memory fetch', async () => {
    const deps = fixture();
    vi.stubEnv('GARDENS_SUBGRAPH_URL', profile.env.GARDENS_SUBGRAPH_URL!);
    const mock = vi.fn(async (target: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      if (target === profile.env.GARDENS_SUBGRAPH_URL) {
        expect(body.query).toContain('typeInt_in: $proposalTypes');
        expect(body.query).toContain('_meta { block { number } hasIndexingErrors }');
        expect(body.query).toContain('$orderBy: Proposal_orderBy!, $orderDirection: OrderDirection!');
        expect(body.variables).toMatchObject({ first: 9, skip: 0, proposalTypes: [1, 0, 2], garden: profile.dao });
        return Response.json({ data: { _meta: { block: { number: 7654312 }, hasIndexingErrors: false }, proposals: [{ id: 'p21', number: '21', type: 'Proposal', metadata: 'Orchard',
          organization: { id: profile.dao } }] } });
      }
      expect(target).toBe(profile.rpcUrl);
      return Response.json({ jsonrpc: '2.0', id: body.id, result: await deps.rpc(body.method, body.params ?? []) });
    });
    vi.stubGlobal('fetch', mock);
    const live = liveDependencies(profile);
    expect(live.client.sendTransaction).toBeUndefined();
    const result = await query(profile, casePage, live);
    expect(result).toMatchObject({ block: String(block), scanned: 1, indexBlock: '7654312', coverage: 'page', rows: [{ state: 'Active Kleros case' }] });
    expect(new Set(deps.calls.map(c => c.method))).toEqual(new Set(['eth_chainId','eth_blockNumber','eth_call']));
    expect(deps.calls.filter(c => c.method === 'eth_call').every(c => c.tag === '0x' + block.toString(16))).toBe(true);
  });

  it('only accepts the structured actor-specific simulation and withholds a submit-ready payload', async () => {
    const { server, deps } = setup();
    const run = (value: unknown) => request(server, '/api/preview/proposal', { method: 'POST', body: JSON.stringify(value) });
    for (const input of [{ ...preview, from: '' }, { ...preview, from: undefined }, { ...preview, extra: true }, { ...preview, stable: 'true' },
      { ...preview, amount: '1e100' }, { ...preview, amount: '0.1234567890123456789' }]) expect((await run(input)).status).toBe(400);
    expect(deps.calls).toEqual([]);
    const res = await run(preview);
    expect(res.json()).toMatchObject({ mode: 'fixture', chainId: 31337, simulation: 'success', gas: '54321',
      method: 'addProposal', from: actor, block: null });
    expect(res.raw).not.toMatch(/confirmationPhrase|private-marker|calldata/);
    expect(new Set(deps.calls.map(c => c.method))).toEqual(new Set(['eth_chainId','eth_getCode','eth_call','eth_estimateGas']));
  });
  it('rejects malformed or cross-origin stake requests before routing', async () => {
    const { server, deps } = setup();
    const valid = { account: actor, target: '0', blockHash: '0x' + 'ab'.repeat(32) };
    const path = '/api/preview/stake';
    const post = (value: unknown, headers?: Record<string, string>) =>
      request(server, path, { method: 'POST', body: JSON.stringify(value), ...(headers ? { headers } : {}) });
    for (const input of [{ ...valid, target: '1e3' }, { ...valid, target: '01' }, { ...valid, target: 'x' },
      { ...valid, target: '0.1234567890123456789' }, { ...valid, target: String(2n ** 256n) },
      { ...valid, blockHash: '0x1234' }, { ...valid, to: actor }]) expect((await post(input)).status).toBe(400);
    expect((await post(valid, { origin: 'https://example.com' })).status).toBe(403);
    expect((await request(server, '/api/stake?account=' + actor + '&account=' + actor)).status).toBe(400);
    expect((await request(server, '/api/stake?account=' + actor + '&courtId=5')).status).toBe(400);
    expect((await request(server, '/api/stake?account=' + actor)).status).toBe(404);
    expect(deps.calls).toEqual([]);
  });
});

describe('My Jury read and ballot review', () => {
  const route = '/api/jury/proposals/21?account=' + actor;
  const ballot = { kind: 'proposals', id: '21', account: actor, roundId: '0', voteIds: ['0'],
    choice: 'challenger', justification: 'Test covenant.' };
  const post = (server: ReturnType<typeof webServer>, input: unknown, headers?: Record<string, string>) =>
    request(server, '/api/preview/jury', { method: 'POST', body: JSON.stringify(input), ...(headers ? { headers } : {}) });

  it('reads only owned seats, including already-voted seats, and joins adapter evidence at one block', async () => {
    const { server, deps } = setup();
    const res = await request(server, route);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ block: String(block), jury: {
      roundId: '0', period: 'vote', canPreview: true, hiddenVotes: false, paused: false,
      seats: [{ voteId: '0', voted: false, choice: null }, { voteId: '2', voted: true, choice: '1' }]
    }, evidence: { status: 'complete', items: [{ uri: 'ipfs://demo-evidence' }, { uri: 'ipfs://demo-challenge' }] } });
    expect(new Set(deps.calls.filter(c => c.method === 'eth_call').map(c => c.tag))).toEqual(new Set(['0x' + block.toString(16)]));
    expect((await request(setup({ evidenceFails: true }).server, route)).json().evidence).toEqual({ status: 'unavailable', items: [] });
    expect((await request(setup({}, { ...profile, evidenceFromBlock: undefined }).server, route)).json().evidence.status).toBe('not-configured');
  });

  it('simulates an explicit, fresh, unsigned ballot without returning signing data', async () => {
    const { server, deps } = setup();
    const res = await post(server, ballot);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({ method: 'castVote', from: actor, to: kit, block: String(block), roundId: '0', simulation: 'success' });
    expect(res.raw).not.toMatch(/calldata|private-marker|confirmationPhrase/);
    expect(deps.ballots).toEqual([[kit, actor, [0n, [0n], 1n, 0n, 'Test covenant.'], block]]);
    const failed = await post(setup({ ballotFails: true }).server, ballot);
    expect(failed.status).toBe(422);
    expect(failed.json().error.code).toBe('simulation');
  });

  it('rejects stale rounds, duplicate/foreign/voted seats, bad bindings, paused/hidden and nonlocal profiles', async () => {
    const { server, deps } = setup();
    for (const change of [{ roundId: '1' }, { voteIds: ['1'] }, { voteIds: ['2'] }]) expect((await post(server, { ...ballot, ...change })).status).toBe(422);
    for (const change of [{ voteIds: ['0','0'] }, { choice: 'auto' }, { sign: true }, { justification: 'a'.repeat(501) }])
      expect((await post(server, { ...ballot, ...change })).status).toBe(400);
    expect((await post(server, ballot, { origin: 'https://other.invalid' })).status).toBe(403);
    expect((await request(server, route + '&account=' + actor)).status).toBe(400);
    for (const opts of [{ paused: true }, { hidden: true }, { ruled: true }]) {
      const scenario = setup(opts);
      expect((await post(scenario.server, ballot)).status).toBe(422);
      expect(scenario.deps.ballots).toEqual([]);
    }
    for (const opts of [{ badReverse: true }, { badOwner: true }]) expect((await request(setup(opts).server, route)).status).toBe(502);
    expect((await post(setup({}, { ...profile, jurySimulation: false }).server, ballot)).status).toBe(422);
    expect(deps.ballots).toEqual([]);
  });
});

describe('local HTTP and startup boundary', () => {
  it('serves fixed assets, rejects foreign origins, and never exposes profile secrets', async () => {
    const { server } = setup();
    const shell = await request(server, '/');
    expect(shell.status).toBe(200);
    expect(shell.headers['Content-Security-Policy']).toContain("connect-src 'self'");
    expect(shell.headers).not.toHaveProperty('Access-Control-Allow-Origin');
    expect(shell.headers['Cache-Control']).toBe('no-store');
    expect((await request(server, '/app.js')).status).toBe(200);
    const context = await request(server, '/api/context');
    expect(context.json()).toMatchObject({ mode: 'fixture', chainId: 31337, previewOnly: true });
    expect(context.raw).not.toMatch(/private-marker|rpcUrl|env|profilePath/);
    for (const headers of [{ host: 'other.example' }, { origin: 'https://foreign.invalid' }, { 'sec-fetch-site': 'cross-site' },
      { 'x-honey-read': '' }]) expect((await request(server, '/api/context', { headers: headers as Record<string,string> })).status).toBe(403);
    expect((await request(server, '/api/preview/proposal', { method: 'POST', headers: { origin: 'null' } })).status).toBe(403);
  });

  it('rejects arbitrary parameters, ambiguous IDs, bodies and methods before touching transport', async () => {
    const { server, deps } = setup();
    for (const path of ['/api/proposals?page=0','/api/votes?page=1&page=2','/api/proposals?from=x',
      '/api/proposals?state=bogus','/api/cases?state=active','/api/proposals/01','/api/votes/' + (2n ** 256n), '/api/votes/0?config=x']) {
      expect((await request(server, path)).status).toBe(400);
    }
    expect((await request(server, '/api/submit', { method: 'POST', body: '{}' })).status).toBe(404);
    expect((await request(server, '/.env')).status).toBe(404);
    expect((await request(server, '/api/context', { method: 'OPTIONS' })).status).toBe(405);
    expect((await request(server, '/api/preview/proposal', { method: 'POST', body: 'x'.repeat(4100) })).status).toBe(413);
    expect((await request(server, '/api/proposals/21', { body: 'unexpected' })).status).toBe(400);
    expect(deps.calls).toEqual([]);
  });

  it('limits active queries and releases slots on deadline', async () => {
    const server = webServer(profile, (_q, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), 'fixture', 20);
    const a = request(server, '/api/proposals'), b = request(server, '/api/votes');
    expect((await request(server, '/api/cases')).status).toBe(429);
    expect((await Promise.all([a,b])).map(r => r.status)).toEqual([504,504]);
    expect((await request(server, '/api/cases')).status).toBe(504);
  });

  it('runs the real isolated worker for a configured source without making an RPC request', async () => {
    const p = parseProfile({ GNOSIS_RPC_URL: profile.rpcUrl });
    const result = await workerRunner(p)({ op: 'list', area: 'votes', page: 1 }, AbortSignal.timeout(7000));
    expect(result).toMatchObject({ coverage: 'no-list-source', rows: [], block: null });
    expect((await request(webServer(p, workerRunner(p)), '/api/context')).json()).toMatchObject({ mode: 'profile', chainId: 100, previewOnly: true });
  });

  it('allows only selected read configuration and validates IDs, chain, addresses and endpoints', () => {
    const valid = { GNOSIS_RPC_URL: profile.rpcUrl, HONEY_WEB_PROPOSALS: '0,1,1', AGENT_WALLET_ADDRESS: actor, NODE_OPTIONS: 'ignored', HONEY_SIGNER_SOCKET: 'ignored' };
    const p = parseProfile(valid);
    expect(p.known.proposals).toEqual(['0','1']);
    expect(parseProfile({ ...valid, THE_GRAPH_API_KEY: 'unused-when-IDs-specified' }).source).toBe('known-ids');
    expect(p.env).not.toHaveProperty('AGENT_WALLET_ADDRESS');
    expect(p.env).not.toHaveProperty('NODE_OPTIONS');
    expect(p.env).not.toHaveProperty('HONEY_SIGNER_SOCKET');
    for (const change of [{ GNOSIS_RPC_URL: '' }, { GNOSIS_RPC_URL: 'file:///tmp/input' }, { HONEY_WEB_CHAIN_ID: '1' },
      { ONEHIVE_CONVICTION_VOTING: 'bad' }, { HONEY_WEB_ADAPTER: 'bad' }, { HONEY_WEB_PROPOSALS: '01' },
      { HONEY_WEB_PROPOSALS: String(2n ** 256n) }, { GARDENS_SUBGRAPH_URL: 'data:invalid' }]) {
      expect(() => parseProfile({ ...valid, ...change })).toThrow();
    }
  });

  it('fails startup for absent profiles, host overrides, extra args and invalid ports without echoing inputs', () => {
    const run = (args: string[]) => spawnSync(process.execPath, ['bin/honey-web.mjs', ...args], { encoding: 'utf8', timeout: 5000 });
    expect(run(['--help']).status).toBe(0);
    for (const args of [[], ['--profile', 'missing-private-marker'], ['--host', 'private-marker'],
      ['--port', '0', '--port', '2'], ['--port', '65536', '--profile', 'private-marker'], ['submit']]) {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage:');
      expect(result.stderr).not.toContain('private-marker');
    }
  });
});
