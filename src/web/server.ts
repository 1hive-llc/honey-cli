import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { pageSize, indexedStates, QueryFailure, validAddress, validId, type Area, type IndexedState, type Kind, type Profile } from './profile.js';
import { detectLikelySecret } from '../onehive/policy.js';
import { publicEvidenceReference } from './public-reference.js';
import type { Query } from './queries.js';

const files = new Map(['/index.html', '/app.js', '/style.css', '/bootstrap.min.css'].map(path =>
  [path, readFileSync(new URL('./assets' + path, import.meta.url))]));
const media: Record<string, string> = {'/index.html': 'text/html', '/app.js': 'text/javascript', '/style.css': 'text/css', '/bootstrap.min.css': 'text/css'};
const apiHeaders = {
  'Cache-Control': 'no-store',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin', 'Cross-Origin-Opener-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};
const errors = {
  'invalid': [400, 'Invalid request. Check the fields and try again.'],
  'forbidden': [403, 'Only the local Honey browser can use this request.'],
  'missing': [404, 'Unknown route.'],
  'method': [405, 'Unsupported method.'],
  'large': [413, 'Request exceeds the allowed size.'],
  'busy': [429, 'Two queries are already running. Try again shortly.'],
  'unavailable': [502, 'The configured source could not complete this read. Check the profile and try again.'],
  'wrong-chain': [502, 'The RPC chain differs from the selected profile. No contract data was used.'],
  'simulation': [422, 'The simulation did not succeed. Check the actor, inputs, and contract state.'],
  'appeal-not-ready': [422, 'A current, linked appeal window could not be verified.'],
  'escalation-not-ready': [422, 'This escalation is not available. Check the current challenge, response deadline, submitter address and funding.'],
  'escalation-stale': [409, 'The chain advanced. Refresh the escalation quote before previewing.'],
  'evidence-not-ready': [422, 'Evidence preview needs a current, linked Agreement dispute and the public address of one of its parties.'],
  'evidence-stale': [409, 'The chain advanced. Refresh the party check before previewing.'],
  'challenge-not-ready': [422, 'Challenge preview is unavailable. Confirm the case uses the configured Kleros court and check the challenger’s permission, HNY balance and allowance.'],
  'challenge-stale': [409, 'The chain advanced. Refresh the challenge quote before previewing.'],
  'decision-not-ready': [422, 'This Decision ballot is not available. Check the local profile, current vote state and voter eligibility.'],
  'jury-not-ready': [422, 'No eligible jury action for this request. Reload the case and check the wallet, round and voting period.'],
  'stake-not-configured': [404, 'This profile has no reviewed Honey staking court configured.'],
  'stake-not-ready': [422, 'Stake preview is unavailable. Check the target, court minimum, wallet eligibility, HNY balance and Core allowance.'],
  'stake-stale': [409, 'The chain advanced. Refresh your stake before previewing.'],
  'timeout': [504, 'The request timed out. The result is unavailable.']
} as const;
type ErrorCode = keyof typeof errors;
class HttpError extends Error { constructor(readonly code: ErrorCode) { super(code); } }
function send(res: ServerResponse, status: number, data: unknown) {
  if (!res.destroyed && !res.writableEnded) res.writeHead(status, { ...apiHeaders, 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(data));
}

export type Runner = (q: Query, signal: AbortSignal) => Promise<unknown>;
export function workerRunner(p: Profile): Runner {
  return (q, signal) => new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { profile: p, query: q }, env: p.env, execArgv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 128 }
    });
    let reply: { ok: boolean; data?: unknown; code?: ErrorCode } | undefined;
    function stop() { void worker.terminate(); }
    signal.addEventListener('abort', stop, { once: true });
    worker.once('message', result => { reply = result; stop(); });
    worker.once('error', () => { reply = undefined; });
    // Hold the concurrency slot until the worker and its outstanding reads have stopped.
    worker.once('exit', () => {
      signal.removeEventListener('abort', stop);
      if (signal.aborted) reject(new HttpError('timeout'));
      else if (reply?.ok) resolve(reply.data);
      else reject(new HttpError(reply?.code && Object.hasOwn(errors, reply.code) ? reply.code : 'unavailable'));
    });
  });
}

const address = z.string().refine(validAddress).transform(s => s as `0x${string}`);
const hnyAmount = z.string().refine(s => {
  const match = /^(0|[1-9]\d{0,58})(?:\.(\d{1,18}))?$/.exec(s);
  return match !== null && BigInt(match[1] + (match[2] || '').padEnd(18, '0')) < 2n ** 256n;
});
const simulation = z.strictObject({ from: address, beneficiary: address, title: z.string().trim().min(1).max(160),
  link: z.string().trim().min(1).max(512), amount: hnyAmount, stable: z.boolean() });
const stake = z.strictObject({ account: address, target: hnyAmount, blockHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) });

const allowanceSnapshot = { account: address, blockHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/) };
const allowance = z.discriminatedUnion('mode', [
  z.strictObject({ ...allowanceSnapshot, mode: z.literal('increase'), target: hnyAmount }),
  z.strictObject({ ...allowanceSnapshot, mode: z.literal('clear') })
]);
const id = z.string().refine(validId);
const kind = z.enum(['proposals', 'votes']);
const escalation = z.strictObject({ ...allowanceSnapshot, kind, id });
const evidence = z.strictObject({ ...allowanceSnapshot, kind, id, reference: z.string().refine(publicEvidenceReference) });
const decision = z.strictObject({ id, account: address, supports: z.boolean() });
const challenge = z.strictObject({ ...allowanceSnapshot, kind, id, offerHny: hnyAmount,
  context: z.string().trim().min(1).max(500).refine(s => Buffer.byteLength(s, 'utf8') <= 1024 && detectLikelySecret(s).length === 0)
});
const ballot = z.strictObject({ kind: z.enum(['proposals', 'votes']), id, account: address, roundId: id,
  voteIds: z.array(id).min(1).max(16).refine(ids => new Set(ids).size === ids.length),
  choice: z.enum(['refuse', 'challenger', 'submitter']), justification: z.string().max(500) });
async function preview(req: IncomingMessage, path: string): Promise<Query> {
  if (req.headers['content-type'] !== 'application/json' || req.headers['transfer-encoding']) throw new HttpError('invalid');
  const size = Number(req.headers['content-length']);
  if (!Number.isSafeInteger(size) || size < 1) throw new HttpError('invalid');
  if (size > 4096) throw new HttpError('large');
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw new HttpError('large');
    chunks.push(chunk);
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (path === '/api/preview/escalation') return { op: 'escalation-preview', input: escalation.parse(body) };
    if (path === '/api/preview/evidence') return { op: 'evidence-preview', input: evidence.parse(body) };
    if (path === '/api/preview/challenge') return { op: 'challenge-preview', input: challenge.parse(body) };
    if (path === '/api/preview/decision-vote') return { op: 'decision-preview', input: decision.parse(body) };
    if (path === '/api/preview/stake-allowance') return { op: 'stake-allowance', input: allowance.parse(body) };
    if (path === '/api/preview/stake') return { op: 'stake-preview', input: stake.parse(body) };
    return path === '/api/preview/jury' ? { op: 'jury-preview', input: ballot.parse(body) } : { op: 'preview', input: simulation.parse(body) };
  }
  catch { throw new HttpError('invalid'); }
}

function readRoute(url: URL, p: Profile): Query {
  if (url.pathname === '/api/stake') {
    const account = url.searchParams.get('account');
    if ([...url.searchParams.keys()].length !== 1 || !account || !validAddress(account)) throw new HttpError('invalid');
    return { op: 'stake', input: { account } };
  }
  if (url.pathname === '/api/jury-inbox') {
    const keys = [...url.searchParams.keys()];
    const account = url.searchParams.get('account');
    const page = url.searchParams.get('page') ?? '1';
    if (new Set(keys).size !== keys.length || keys.some(k => k !== 'account' && k !== 'page') ||
        !account || !validAddress(account) || !/^[1-9]\d{0,4}$/.test(page)) throw new HttpError('invalid');
    return { op: 'jury-inbox', account, page: Number(page) };
  }
  const list = /^\/api\/(proposals|votes|cases)$/.exec(url.pathname);
  if (list) {
    const page = url.searchParams.get('page') ?? '1';
    const state = url.searchParams.get('state');
    const keys = [...url.searchParams.keys()];
    if (!/^[1-9]\d{0,4}$/.test(page) || new Set(keys).size !== keys.length || keys.some(k => k !== 'page' && k !== 'state') ||
        (state !== null && (list[1] === 'cases' || p.source !== 'gardens' || !indexedStates.includes(state as IndexedState)))) throw new HttpError('invalid');
    return { op: 'list', area: list[1] as Area, page: Number(page), ...(state ? { state: state as IndexedState } : {}) };
  }
  const jury = /^\/api\/jury\/(proposals|votes)\/([^/]+)$/.exec(url.pathname);
  if (jury) {
    const account = url.searchParams.get('account');
    if ([...url.searchParams.keys()].length !== 1 || !validId(jury[2]!) || !account || !validAddress(account)) throw new HttpError('invalid');
    return { op: 'jury', input: { kind: jury[1] as Kind, id: jury[2]!, account } };
  }
  const quote = /^\/api\/(challenge|evidence|escalation)\/(proposals|votes)\/([^/]+)$/.exec(url.pathname);
  if (quote) {
    const account = url.searchParams.get('account');
    if ([...url.searchParams.keys()].length !== 1 || !validId(quote[3]!) || !account || !validAddress(account)) throw new HttpError('invalid');
    return { op: quote[1] === 'evidence' ? 'evidence' : quote[1] === 'escalation' ? 'escalation' : 'challenge', input: { kind: quote[2] as Kind, id: quote[3]!, account } };
  }
  const appeal = /^\/api\/appeal\/(proposals|votes)\/([^/]+)$/.exec(url.pathname);
  if (appeal) {
    if (url.search || !validId(appeal[2]!)) throw new HttpError('invalid');
    return { op: 'appeal', kind: appeal[1] as Kind, id: appeal[2]! };
  }
  const settlement = /^\/api\/settlement\/(proposals|votes)\/([^/]+)$/.exec(url.pathname);
  if (settlement) {
    if (url.search || !validId(settlement[2]!)) throw new HttpError('invalid');
    return { op: 'settlement', kind: settlement[1] as Kind, id: settlement[2]! };
  }
  const detail = /^\/api\/(proposals|votes)\/([^/]+)$/.exec(url.pathname);
  if (detail) {
    if (url.search || !validId(detail[2]!)) throw new HttpError('invalid');
    return { op: 'detail', kind: detail[1] as Kind, id: detail[2]! };
  }
  throw new HttpError('missing');
}

export function webServer(p: Profile, run: Runner, mode: 'profile' | 'fixture' = 'profile', deadline = 20000) {
  let active = 0;
  const server = createServer({ maxHeaderSize: 8192, headersTimeout: 6000, requestTimeout: 8000,
    connectionsCheckingInterval: 1000, keepAliveTimeout: 3000 }, async (req, res) => {
    try {
      const host = '127.0.0.1:' + req.socket.localPort;
      const origin = 'http://' + host;
      const { headers } = req;
      if (headers.host !== host || (headers.origin !== undefined && headers.origin !== origin) ||
          (headers['sec-fetch-site'] && !['same-origin', 'none'].includes(String(headers['sec-fetch-site'])))) throw new HttpError('forbidden');
      const target = req.url ?? '';
      if (target.length > 512) throw new HttpError('large');
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\') || target.includes('#') || /(?:^|\/)\.{1,2}(?:\/|$)/.test(target)) throw new HttpError('invalid');
      const url = new URL(target, origin);
      if (url.origin !== origin) throw new HttpError('forbidden');
      if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError('method');
      if (req.method === 'GET' && (headers['transfer-encoding'] || Number(headers['content-length'] || 0) !== 0)) throw new HttpError('invalid');
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      if (files.has(path)) {
        if (req.method !== 'GET' || url.search) throw new HttpError('invalid');
        res.writeHead(200, { ...apiHeaders, 'Content-Type': media[path] + '; charset=utf-8' }).end(files.get(path));
        return;
      }
      if (!path.startsWith('/api/')) throw new HttpError('missing');
      if (headers['x-honey-read'] !== '1') throw new HttpError('forbidden');
      if (path === '/api/context' && req.method === 'GET' && !url.search) {
        send(res, 200, { mode, chainId: p.chainId, source: p.source, dao: p.dao, adapter: p.adapter ?? null, pageSize, previewOnly: true, localSimulation: p.jurySimulation });
        return;
      }
      if (active >= 2) throw new HttpError('busy');
      let q: Query;
      if (req.method === 'POST') {
        if (headers.origin !== origin) throw new HttpError('forbidden');
        if (!['/api/preview/proposal', '/api/preview/jury', '/api/preview/stake', '/api/preview/stake-allowance', '/api/preview/decision-vote', '/api/preview/challenge', '/api/preview/evidence', '/api/preview/escalation'].includes(path) || url.search) throw new HttpError('missing');
        q = await preview(req, path);
      } else q = readRoute(url, p);
      if (active >= 2) throw new HttpError('busy');
      active++;
      const controller = new AbortController();
      const stop = () => controller.abort(new HttpError('timeout'));
      const timer = setTimeout(stop, deadline);
      res.once('close', stop);
      try {
        if (res.destroyed) throw new HttpError('timeout');
        const data = await run(q, controller.signal);
        send(res, 200, { mode, chainId: p.chainId, ...data as object });
      } finally {
        active--;
        clearTimeout(timer);
        res.off('close', stop);
      }
    } catch (e) {
      const code = e instanceof HttpError || e instanceof QueryFailure ? e.code : 'unavailable';
      const [status, message] = errors[code];
      send(res, status, { error: { code, message } });
    }
  });
  server.maxConnections = 16;
  server.maxRequestsPerSocket = 50;
  server.setTimeout(25000, socket => socket.destroy());
  server.on('clientError', (_err, socket) => socket.destroy());
  return server;
}

export async function listen(server: ReturnType<typeof webServer>, port: number) {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error();
  return 'http://127.0.0.1:' + addr.port;
}
