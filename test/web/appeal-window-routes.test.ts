import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { query } from '../../src/web/queries.js';
import { webServer } from '../../src/web/server.js';
import { block, core, kit, fixture, profile } from '../../examples/governance/fixture.js';
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



const route = '/api/appeal/proposals/21';
const trusted: typeof profile = {...profile, appealKit:kit};
describe('read-only appeal window route', () => {
  it.each([1n, 2n])('reads %s court rounds independently of a final Honey ruling', async (roundCount) => {
    const { server } = setup({ roundCount }, trusted);
    const response = await request(server, '/api/settlement/proposals/21');
    expect(response.status).toBe(200);
    expect(response.json().receipt).toMatchObject({roundCount: String(roundCount), stage: 'before-callback', appliedAgreementRuling: null});
  });
  it.each([[149n,true,true],[150n,false,true],[201n,false,false]] as const)('honors exclusive cutoffs at %s', async (appealTime,loserOpen,winnerOpen) => {
    const {server,deps} = setup({appeal:'known',appealTime,stakePhase:0},trusted);
    const res = await request(server,route);
    expect(res.json()).toMatchObject({kind:'proposals',id:'21',roundId:'0',block:String(block),observedAt:String(appealTime),start:'100',end:'201',
      preliminaryChoice:'1',tied:false,paused:false,feeAsset:'HNY',baseCostRaw:String(2n*10n**18n),choices:[
        {choice:'0',cutoff:'150',funded:false,open:loserOpen,targetRaw:String(6n*10n**18n)},
        {choice:'1',cutoff:'201',funded:false,open:winnerOpen,targetRaw:String(4n*10n**18n)},
        {choice:'2',cutoff:'150',funded:true,open:false,targetRaw:String(6n*10n**18n)}]});
    expect(deps.calls.length).toBeGreaterThan(8);
    expect(deps.calls.every(c=>c.method==='eth_call' && c.tag==='0x'+'a5'.repeat(32))).toBe(true);
  });
  it('shows no HNY amounts for an unknown fee asset', async () => {
    const {server}=setup({appeal:'other-token',stakePhase:0},trusted);
    const view=(await request(server,route)).json();
    expect(view).toMatchObject({feeAsset:null,baseCostRaw:null,choices:[{targetRaw:null},{targetRaw:null},{targetRaw:null}]});
    expect(view.choices[2].funded).toBe(true);
  });
  it('does not expose a write endpoint or accept an account or selector override', async () => {
    const {server,deps}=setup({appeal:'known',stakePhase:0},trusted);
    expect((await request(server,route+'?account='+core)).status).toBe(400);
    expect((await request(server,route,{method:'POST',body:'{}'})).status).toBe(404);
    expect(deps.calls).toEqual([]);
  });
});
