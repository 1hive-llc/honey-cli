import { request as httpRequest } from 'node:http';
import { signerResponseSchema, type SignerRequest, type SignerResponse } from './signer-protocol.js';

export type SignerClientOptions = {
  url?: string;
  socketPath?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

function signerUrl(url?: string): string {
  return url ?? process.env.HONEY_SIGNER_URL ?? 'http://127.0.0.1:19777';
}

function signerSocket(socketPath?: string): string | undefined {
  return socketPath ?? process.env.HONEY_SIGNER_SOCKET;
}

function redactedEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';
    for (const key of [...parsed.searchParams.keys()]) if (/key|token|secret|auth/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    return parsed.toString();
  } catch {
    return '[invalid signer endpoint]';
  }
}

async function requestViaSocket(request: SignerRequest, socketPath: string, timeoutMs: number): Promise<string> {
  const body = JSON.stringify(request);
  return await new Promise<string>((resolve, reject) => {
    const req = httpRequest({ socketPath, path: '/v1/sign', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) reject(new Error(`Signer socket returned HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
        else resolve(text);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Signer socket ${socketPath} timed out.`)));
    req.on('error', reject);
    req.end(body);
  });
}

function parseSignerResponse(text: string, requestId: string): SignerResponse {
  let payload: unknown;
  try { payload = JSON.parse(text) as unknown; } catch { throw new Error('Signer endpoint returned malformed JSON.'); }
  const parsed = signerResponseSchema.parse(payload);
  if (parsed.requestId !== requestId) throw new Error('Signer response requestId did not match request.');
  return parsed;
}

export async function requestExternalSignature(request: SignerRequest, options: SignerClientOptions = {}): Promise<SignerResponse> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.HONEY_SIGNER_TIMEOUT_MS ?? 30_000);
  const socketPath = signerSocket(options.socketPath);
  if (socketPath) return parseSignerResponse(await requestViaSocket(request, socketPath, timeoutMs), request.requestId);

  const base = signerUrl(options.url).replace(/\/+$/, '');
  const endpoint = `${base}/v1/sign`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await (options.fetchImpl ?? fetch)(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: controller.signal
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`Signer endpoint ${redactedEndpoint(endpoint)} returned HTTP ${response.status}: ${text.slice(0, 200)}`);
    return parseSignerResponse(text, request.requestId);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Signer endpoint ${redactedEndpoint(endpoint)} timed out.`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
