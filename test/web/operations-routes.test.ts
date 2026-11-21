import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { query } from '../../src/web/queries.js';
import { webServer } from '../../src/web/server.js';
import { actor, core, block, fixture, profile } from '../../examples/governance/fixture.js';
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
function setup(options: Parameters<typeof fixture>[0] = {}, p: typeof profile = { ...profile, stake: { core, courtId: '1' } }) {
  const deps = fixture(options);
  const server = webServer(p, q => query(p, q, deps), 'fixture');
  return { server, deps };
}

describe('Governance web operation routes', () => {
  const post = (s: ReturnType<typeof webServer>, op: string, input: unknown) => request(s, '/api/preview/' + op,
    { method: 'POST', body: JSON.stringify(input) });
  it('simulates a local Decision vote, not a juror ballot', async () => {
    const {server, deps} = setup();
    const input = { account: actor, id: '0', supports: false };
    const res = await post(server, 'decision-vote', input);
    expect(res.json()).toMatchObject({ ...input, submitted: false, simulation: 'success' });
    expect(deps.calls.some(c => c.method === 'eth_estimateGas')).toBe(true);
    expect(deps.ballots).toHaveLength(0);
    expect((await post(server, 'decision-vote', { ...input, id: '21', voteIds: ['0'] })).status).toBe(400);
    expect((await post(server, 'decision-vote', { ...input, account: core })).json().error.code).toBe('decision-not-ready');
    expect(deps.calls.some(c => c.method.startsWith('eth_send'))).toBe(false);
  });
  it.each([false,true])('pins an exact allowance preview; zero starting allowance: %s', async zeroAllowance => {
    const {server} = setup({stakePhase:0, zeroAllowance});
    const before = (await request(server, '/api/stake?account='+actor)).json();
    const base = {account: actor, blockHash:before.blockHash};
    const operation = zeroAllowance ? {mode:'increase', target:'51.000000000000000001'} : {mode:'clear'};
    const res = await post(server, 'stake-allowance', {...base, ...operation});
    expect(res.json()).toMatchObject({...base, spender:core, approvalRaw:zeroAllowance?'1000000000000000001':'0', submitted:false});
    expect((await request(server, '/api/stake?account='+actor)).json()).toEqual(before);
    expect((await post(server, 'stake-allowance', {...base, ...operation, spender:actor})).status).toBe(400);
    expect((await post(server, 'stake-allowance', {...base, ...operation, blockHash:'0x'+'aa'.repeat(32)})).json().error.code).toBe('stake-stale');
  });
  it('does not treat missing fee getters as resolution or an unverified link as a receipt', async () => {
    for (const [options, stage] of [[{},'before-callback'],[{badReverse:true},'unavailable']] as const) {
      const {server, deps} = setup(options);
      const res = await request(server,'/api/settlement/proposals/21');
      expect(res.json()).toMatchObject({block:String(block), receipt:{stage, amounts:null, appliedAgreementRuling:null}});
      expect(new Set(deps.calls.filter(c=>c.method==='eth_call').map(c=>c.tag))).toEqual(new Set(['0x'+block.toString(16)]));
    }
  });
});
