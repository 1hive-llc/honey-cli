import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { describe, it, expect } from 'vitest';
import { query } from '../../src/web/queries.js';
import { webServer } from '../../src/web/server.js';
import { stringToHex } from 'viem';
import { actor, core, fixture, profile } from '../../examples/governance/fixture.js';
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
const unit = 10n ** 18n;
describe('pinned, simulation-only challenge routes', () => {
  it.each([['proposals','20','120'],['votes','0','81']])('binds %s/%s to Agreement action %s', async (kind,id,actionId) => {
    const {server,deps} = setup({stakePhase:0, challenge:true});
    const path = '/api/challenge/'+kind+'/'+id+'?account=';
    const before = (await request(server,path+actor)).json();
    expect(before).toMatchObject({kind,id,account:actor,actionId,blockHash:hash,eligible:true,
      challengerCollateralRaw:String(4n*unit), arbitratorFeeRaw:String(2n*unit), totalDebitRaw:String(6n*unit), maximumOfferRaw:String(10n*unit)});
    expect((await request(server,path+core)).json()).toMatchObject({eligible:false});
    const quote = {kind,id,account:actor,blockHash:hash,offerHny:'1.000000000000000001',context:'Public fixture rationale'};
    const post = (input:unknown) => request(server,'/api/preview/challenge',{method:'POST',body:JSON.stringify(input)});
    const res = await post(quote);
    expect(res.json()).toMatchObject({...before, settlementOfferRaw:String(unit+1n),submitted:false});
    expect(res.raw).not.toMatch(/calldata|confirmationPhrase|Public fixture rationale/i);
    expect((await post({...quote,blockHash:'0x'+'b5'.repeat(32)})).status).toBe(409);
    expect((await post({...quote,account:core})).status).toBe(422);
    expect((await post({...quote,offerHny:'10.000000000000000001'})).status).toBe(422);
    expect((await post({...quote,actionId:'1'})).status).toBe(400);
    expect((await request(server,path+actor+'&action=2')).status).toBe(400);
    expect(deps.challenges).toEqual([{from:actor, actionId:BigInt(actionId),offer:unit+1n,finished:false,context:stringToHex(quote.context)}]);
    expect((await request(server,path+actor)).json()).toEqual(before);
    expect(deps.calls.every(c=>c.method==='eth_call' && c.tag===hash)).toBe(true);
  });
});
