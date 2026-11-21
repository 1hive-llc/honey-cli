import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { query } from '../../src/web/queries.js';
import { webServer } from '../../src/web/server.js';
import { stringToHex } from 'viem';
import { actor, core, dispute, otherJuror, fixture, profile } from '../../examples/governance/fixture.js';
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
const candidate = {kind:'proposals', id:'21'};
const path = '/api/evidence/proposals/21?account=';
const reference = 'Référence témoin 7';
describe('party evidence routes', () => {
  it.each([[actor,'challenger'],[otherJuror,'submitter']])('verifies an Agreement party, encodes exact UTF-8, leaves state unchanged (%s)', async (account,role) => {
    const {server,deps} = setup({partyEvidence:true,stakePhase:0});
    const before = (await request(server,path+account)).json();
    expect(before).toMatchObject({...candidate,account,actionId:'121',period:'evidence',role,blockHash:hash});
    const post = (input:unknown) => request(server,'/api/preview/evidence',{method:'POST',body:JSON.stringify(input)});
    const payload = {...candidate,account,blockHash:hash,reference};
    const res = await post(payload);
    expect(res.status).toBe(200);
    expect(res.json()).toMatchObject({...before,submitted:false,byteLength:Buffer.byteLength(reference)});
    expect(res.raw).not.toContain(reference);
    expect(res.raw).not.toContain(stringToHex(reference).slice(2));
    expect((await request(server,path+core)).status).toBe(422);
    expect((await post({...payload,account:core})).status).toBe(422);
    expect((await post({...payload,blockHash:'0x'+'bb'.repeat(32)})).status).toBe(409);
    expect((await post({...payload,finished:true})).status).toBe(400);
    expect((await request(server,path+account+'&role=submitter')).status).toBe(400);
    expect(deps.evidenceCalls).toEqual([{from:account,disputeId:dispute,finished:false,reference:stringToHex(reference)}]);
    expect((await request(server,path+account)).json()).toEqual(before);
    expect(deps.calls.every(c=>c.method==='eth_call' && c.tag===hash)).toBe(true);
  });
  it.each([{badReverse:true},{ruled:true},{noCases:true}])('never simulates a broken or resolved court link %j', async options => {
    const {server,deps} = setup({...options,partyEvidence:true,stakePhase:0});
    const res = await request(server,'/api/preview/evidence',{method:'POST',body:JSON.stringify({...candidate,account:actor,blockHash:hash,reference})});
    expect(res.status).toBe(422);
    expect(deps.evidenceCalls).toEqual([]);
  });
});
