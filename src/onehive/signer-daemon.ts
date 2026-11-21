import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFile, mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createChainClientFromEnv, type ChainClient } from './clients/chain.js';
import { decryptKeystore, readPassphraseFromFile, readPassphraseInteractively, resolveKeystore } from './keystore.js';
import { evaluateKeystorePolicy, loadKeystorePolicy } from './keystore-policy.js';
import { hasFailedPolicy } from './policy.js';
import { signerRequestSchema, signerResponseSchema, type SignerRequest, type SignerResponse } from './signer-protocol.js';
import { preflightSubmitPreview } from './tools/tx-preflight.js';
import type { HexAddress, HexData, PolicyCheck, TxPreview } from './schemas.js';

const DEFAULT_SIGNER_AUDIT_LOG = '.pi/sessions/honey-signer-audit.log';

export type UnlockedSigner = { address: HexAddress; label: string; privateKey: HexData };
export type SignerDaemonDeps = { client?: ChainClient; auditLogPath?: string; policyPath?: string; now?: Date };

async function appendSignerAudit(event: Record<string, unknown>, path = process.env.HONEY_SIGNER_AUDIT_LOG ?? DEFAULT_SIGNER_AUDIT_LOG): Promise<string> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(event)}\n`, 'utf8');
  return path;
}

function requestSummary(request: SignerRequest): Record<string, unknown> {
  return { requestId: request.requestId, previewHash: request.previewHash, account: request.account, label: request.label, chainId: request.tx.chainId, to: request.tx.to, method: request.tx.decoded.method, value: request.tx.value };
}

function response(status: SignerResponse['status'], requestId: string, patch: Partial<SignerResponse> = {}): SignerResponse {
  return signerResponseSchema.parse({ version: 1, requestId, status, ...patch });
}

export async function handleSignerRequest(raw: unknown, signer: UnlockedSigner, deps: SignerDaemonDeps = {}): Promise<SignerResponse> {
  let request: SignerRequest;
  try {
    request = signerRequestSchema.parse(raw);
  } catch (error) {
    const requestId = raw && typeof raw === 'object' && !Array.isArray(raw) && typeof (raw as { requestId?: unknown }).requestId === 'string' ? (raw as { requestId: string }).requestId : randomUUID();
    await appendSignerAudit({ at: (deps.now ?? new Date()).toISOString(), status: 'rejected', reason: 'invalid_request', requestId }, deps.auditLogPath);
    return response('rejected', requestId, { message: error instanceof Error ? error.message : 'Invalid signer request.', retryable: false });
  }

  const auditBase = { at: (deps.now ?? new Date()).toISOString(), tool: 'honey-signer', signer: { address: signer.address, label: signer.label }, request: requestSummary(request) };
  if (request.tx.from?.toLowerCase() !== signer.address.toLowerCase() || (request.account && request.account.toLowerCase() !== signer.address.toLowerCase())) {
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'rejected', reason: 'wrong_account' }, deps.auditLogPath);
    return response('rejected', request.requestId, { message: `Signer account ${signer.address} does not match requested tx.from/account.`, signerAuditId: auditPath, retryable: false });
  }

  const tx = request.tx as TxPreview;
  const client = deps.client ?? createChainClientFromEnv(tx.chainId);
  const verified = await preflightSubmitPreview({ tx, signerMode: 'external-signer', client });
  if (hasFailedPolicy(verified.checks)) {
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'rejected', reason: 'preflight_failed', checks: verified.checks }, deps.auditLogPath);
    return response('rejected', request.requestId, { message: 'Signer preflight checks failed.', signerAuditId: auditPath, retryable: false });
  }

  let keystoreChecks: PolicyCheck[];
  try {
    const policy = await loadKeystorePolicy(deps.policyPath);
    keystoreChecks = evaluateKeystorePolicy({ policy, tx: verified.tx, account: signer.address, ...(verified.selector.selector ? { selector: verified.selector.selector } : {}) });
  } catch (error) {
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'rejected', reason: 'policy_unavailable', error: error instanceof Error ? error.message : 'Policy unavailable.' }, deps.auditLogPath);
    return response('rejected', request.requestId, { message: error instanceof Error ? error.message : 'Signer policy unavailable.', signerAuditId: auditPath, retryable: false });
  }
  if (hasFailedPolicy(keystoreChecks)) {
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'rejected', reason: 'keystore_policy_blocked', checks: keystoreChecks }, deps.auditLogPath);
    return response('rejected', request.requestId, { message: 'Signer policy blocked this transaction.', signerAuditId: auditPath, retryable: false });
  }

  if (!client.sendTransaction) {
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'rejected', reason: 'send_unavailable' }, deps.auditLogPath);
    return response('error', request.requestId, { message: 'Chain client does not support sending transactions.', signerAuditId: auditPath, retryable: true });
  }

  try {
    const txHash = await client.sendTransaction(verified.tx, signer.privateKey);
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'submitted', txHash, checksHash: createHash('sha256').update(JSON.stringify({ preflight: verified.checks, keystore: keystoreChecks })).digest('hex') }, deps.auditLogPath);
    return response('submitted', request.requestId, { txHash, signerAuditId: auditPath, message: 'Transaction submitted by honey-signer policy.' });
  } catch (error) {
    const auditPath = await appendSignerAudit({ ...auditBase, status: 'ambiguous', reason: 'send_failed', error: error instanceof Error ? error.message : 'Send failed.' }, deps.auditLogPath);
    return response('ambiguous', request.requestId, { message: error instanceof Error ? error.message : 'Transaction send failed after signer attempted submission.', signerAuditId: auditPath, retryable: true });
  }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

export async function startSignerDaemon(input: { signer: UnlockedSigner; host?: string; port?: number; socketPath?: string; deps?: SignerDaemonDeps }): Promise<{ close(): Promise<void>; url: string; socketPath?: string }> {
  const socketPath = input.socketPath ?? process.env.HONEY_SIGNER_SOCKET;
  const host = input.host ?? process.env.HONEY_SIGNER_HOST ?? '127.0.0.1';
  const port = input.port ?? Number(process.env.HONEY_SIGNER_PORT ?? 19777);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    if (req.method !== 'POST' || req.url !== '/v1/sign') {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    try {
      const result = await handleSignerRequest(await readBody(req), input.signer, input.deps);
      res.statusCode = result.status === 'error' ? 500 : result.status === 'rejected' ? 403 : 200;
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ version: 1, requestId: randomUUID(), status: 'error', message: error instanceof Error ? error.message : 'Signer daemon failed.' }));
    }
  });
  if (socketPath) {
    await mkdir(dirname(socketPath), { recursive: true });
    await rm(socketPath, { force: true });
  }
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    if (socketPath) server.listen(socketPath, () => resolve());
    else server.listen(port, host, () => resolve());
  });
  return { url: socketPath ? `unix:${socketPath}` : `http://${host}:${port}`, ...(socketPath ? { socketPath } : {}), close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

export async function unlockSignerFromKeystore(identifier: string, dir?: string, passphraseProvider?: (label: string) => Promise<string>): Promise<UnlockedSigner> {
  const metadata = await resolveKeystore(identifier, dir);
  const passphrase = passphraseProvider
    ? await passphraseProvider(metadata.label)
    : process.env.HONEY_KEYSTORE_ALLOW_PASSPHRASE_FILE === '1'
      ? await readPassphraseFromFile()
      : await readPassphraseInteractively(metadata.label);
  return decryptKeystore(metadata.path, passphrase);
}
