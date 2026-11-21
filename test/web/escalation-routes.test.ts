import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { query } from '../../src/web/queries.js';
import { webServer } from '../../src/web/server.js';
import { actor, core, otherJuror, fixture, profile } from '../../examples/governance/fixture.js';
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


const hash = '0x' + 'a5'.repeat(32);
const payload = {kind:'proposals', id:'21', account:otherJuror, blockHash:hash};
const quote = '/api/escalation/proposals/21?account=';
const post = (server: ReturnType<typeof webServer>, input:unknown) => request(server, '/api/preview/escalation',
  {method:'POST', body:JSON.stringify(input)});
describe('Agreement escalation routes', () => {
  it('charges only the current submitter fee, simulates once, and never opens a dispute', async () => {
    const {server,deps} = setup({escalation:'waiting',stakePhase:0});
    const before = (await request(server,quote+otherJuror)).json();
    expect(before).toMatchObject({...payload, actionId:'121',challengeId:'7',eligible:true,deadline:'1760003600',
      challengerFeeEscrowRaw:'2000000000000000000',submitterFeeRaw:'3000000000000000000'});
    const res = await post(server,payload);
    expect(res.json()).toMatchObject({...before,submitted:false});
    expect((await request(server,quote+otherJuror)).json()).toEqual(before);
    for (const account of [actor, core]) {
      expect((await request(server,quote+account)).json()).toMatchObject({eligible:false});
      expect((await post(server,{...payload,account})).status).toBe(422);
    }
    expect((await post(server,{...payload,blockHash:'0x'+'bb'.repeat(32)})).status).toBe(409);
    expect((await post(server,{...payload,finished:true})).status).toBe(400);
    expect((await request(server,quote+otherJuror+'&action=2')).status).toBe(400);
    expect(deps.escalationCalls).toEqual([{from:otherJuror,actionId:121n,finished:false}]);
    expect(deps.calls.every(c=>c.method==='eth_call' && c.tag===hash)).toBe(true);
  });
  it.each(['expired','underfunded'] as const)('does not simulate a Waiting challenge that is %s', async escalation => {
    const {server,deps} = setup({stakePhase:0,escalation});
    expect((await request(server,quote+otherJuror)).json()).toMatchObject({eligible:false});
    expect((await post(server,payload)).status).toBe(422);
    expect(deps.escalationCalls).toEqual([]);
  });
  it('does not offer escalation for an already Disputed challenge', async () => {
    const {server,deps} = setup({partyEvidence:true,stakePhase:0});
    expect((await request(server,quote+otherJuror)).status).toBe(422);
    expect((await post(server,payload)).status).toBe(422);
    expect(deps.escalationCalls).toEqual([]);
  });
});
