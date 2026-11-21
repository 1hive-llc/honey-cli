import { mkdir, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname } from 'node:path';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import type { ToolDefinition } from '../tool-types.js';
import { evaluateTxPolicy, generateConfirmationPhrase, hasFailedPolicy, isHexAddress } from '../policy.js';
import { decryptKeystore, readPassphraseFromFile, readPassphraseInteractively, resolveKeystore } from '../keystore.js';
import { evaluateKeystorePolicy, loadKeystorePolicy } from '../keystore-policy.js';
import { requestExternalSignature } from '../signer-client.js';
import { buildSignerRequest } from '../signer-protocol.js';
import { cloneTxPreview, preflightSubmitPreview } from './tx-preflight.js';
import { addressPattern, fail, ok, type ChainId, type HexAddress, type HexData, type OneHiveToolResult, type TxPreview } from '../schemas.js';

const AUDIT_LOG_PATH = '.pi/sessions/onehive-audit.log';

export type SignerMode = 'safe' | 'ledger' | 'dev-private-key' | 'keystore' | 'external-signer' | 'signer-daemon';
export type TxSimulateInput = { tx: TxPreview; chainId?: ChainId };
export type TxSubmitInput = {
  tx: TxPreview;
  confirmationPhrase: string;
  signerMode?: SignerMode;
  safeAddress?: HexAddress;
  keystoreAccount?: string;
  keystoreLabel?: string;
  externalSignerUrl?: string;
  externalSignerSocket?: string;
};

export type TxApproveSubmitInput = Omit<TxSubmitInput, 'confirmationPhrase'> & {
  waitForReceipt?: boolean;
  receiptTimeoutMs?: number;
  receiptPollIntervalMs?: number;
};

export type TxReceiptStatus = { status: 'success' | 'reverted' | 'timeout'; blockNumber?: string; gasUsed?: string };

export type TxSubmitOutput = {
  status: 'proposed' | 'submitted';
  mode: SignerMode;
  txHash?: string;
  safeUrl?: string;
  auditLogPath?: string;
  handoff: Record<string, unknown>;
  receipt?: TxReceiptStatus;
};

type TxDeps = { client?: ChainClient; auditLogPath?: string; now?: Date; devPrivateKey?: HexData; keystorePassphrase?: string; keystorePassphraseProvider?: (label: string) => Promise<string>; keystoreDir?: string; keystorePolicyPath?: string; externalSignerRequest?: typeof requestExternalSignature };

function redactedTx(tx: TxPreview): Record<string, unknown> {
  return {
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    dataLength: tx.data.length,
    contractName: tx.decoded.contractName,
    method: tx.decoded.method,
    simulationStatus: tx.simulation.status,
    risk: tx.policy.risk
  };
}

async function appendAudit(event: Record<string, unknown>, auditLogPath = AUDIT_LOG_PATH): Promise<string> {
  await mkdir(dirname(auditLogPath), { recursive: true });
  await appendFile(auditLogPath, `${JSON.stringify(event)}\n`, 'utf8');
  return auditLogPath;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactedRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = '[REDACTED]';
    if (parsed.password) parsed.password = '[REDACTED]';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/key|token|secret|project|auth/i.test(key)) parsed.searchParams.set(key, '[REDACTED]');
    }
    return parsed.toString();
  } catch {
    return '[unparseable RPC URL]';
  }
}

async function rpcCall<T>(chainId: ChainId, method: string, params: unknown[]): Promise<T> {
  const client = createChainClientFromEnv(chainId);
  const endpoint = redactedRpcUrl(client.rpcUrl);
  let response: Response;
  try {
    response = await fetch(client.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
  } catch (error) {
    throw new Error(`RPC ${method} network request failed for ${endpoint}: ${error instanceof Error ? error.message : 'unknown network error'}`);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`RPC ${method} HTTP ${response.status} from ${endpoint}: ${text.slice(0, 200) || response.statusText}`);
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`RPC ${method} returned malformed JSON from ${endpoint}.`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error(`RPC ${method} returned an invalid JSON-RPC payload from ${endpoint}.`);
  const record = payload as { result?: T; error?: { message?: string } };
  if (record.error) throw new Error(record.error.message ?? `RPC ${method} failed.`);
  if (!('result' in record)) throw new Error(`RPC ${method} response from ${endpoint} is missing result.`);
  return record.result as T;
}

export async function waitForTxReceipt(input: { chainId: ChainId; txHash: string; timeoutMs?: number; pollIntervalMs?: number }): Promise<TxReceiptStatus> {
  const deadline = Date.now() + (input.timeoutMs ?? 180_000);
  const interval = input.pollIntervalMs ?? 4_000;
  while (Date.now() <= deadline) {
    const receipt = await rpcCall<{ status?: string; blockNumber?: string; gasUsed?: string } | null>(input.chainId, 'eth_getTransactionReceipt', [input.txHash]);
    if (receipt) {
      return {
        status: receipt.status === '0x1' ? 'success' : 'reverted',
        ...(receipt.blockNumber ? { blockNumber: BigInt(receipt.blockNumber).toString() } : {}),
        ...(receipt.gasUsed ? { gasUsed: BigInt(receipt.gasUsed).toString() } : {})
      };
    }
    await sleep(interval);
  }
  return { status: 'timeout' };
}

function safeUrl(safeAddress: HexAddress | undefined, tx: TxPreview): string | undefined {
  const safe = safeAddress ?? (isHexAddress(process.env.SAFE_ADDRESS ?? '') ? process.env.SAFE_ADDRESS as HexAddress : undefined);
  if (!safe) return undefined;
  const params = new URLSearchParams({
    safe: `gno:${safe}`,
    to: tx.to,
    value: tx.value,
    data: tx.data
  });
  return `https://app.safe.global/transactions/tx-builder?${params.toString()}`;
}

export async function simulateTxPreview(input: TxSimulateInput, deps: TxDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const tx = cloneTxPreview(input.tx);
    const chainId = input.chainId ?? tx.chainId;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const activeChainId = await client.getChainId();
    if (activeChainId !== chainId || tx.chainId !== chainId) {
      return fail('wrong_chain', `RPC endpoint is connected to chain ${activeChainId}, tx is for ${tx.chainId}, requested ${chainId}.`, undefined, false);
    }
    const bytecode = await client.getBytecode(tx.to);
    const targetHasCode = Boolean(bytecode && bytecode !== '0x');
    try {
      if (client.call) await client.call(tx);
      const gas = await client.estimateGas(tx);
      tx.simulation = { status: 'success', gasEstimate: gas.toString() };
    } catch (error) {
      tx.simulation = { status: 'revert', revertReason: error instanceof Error ? error.message : 'eth_call or gas estimation reverted.' };
    }
    const policyContext: Parameters<typeof evaluateTxPolicy>[1] = {
      chainId: tx.chainId,
      allowTestnetWrites: tx.chainId !== 100,
      targetHasCode,
      methodSelectorKnown: tx.data !== '0x',
      simulationStatus: tx.simulation.status
    };
    if (tx.policy.checks.some((check) => check.name === 'abi-lock' && check.status === 'pass')) policyContext.abiLockStatus = 'match';
    tx.policy.checks = evaluateTxPolicy(tx, policyContext);
    await appendAudit({ at: (deps.now ?? new Date()).toISOString(), tool: 'onehive_tx_simulate', status: tx.simulation.status, tx: redactedTx(tx), checks: tx.policy.checks }, deps.auditLogPath);
    if (tx.simulation.status === 'revert') return fail('simulation_reverted', 'Transaction simulation reverted.', tx, false);
    if (hasFailedPolicy(tx.policy.checks)) return fail('policy_blocked', 'Transaction simulation completed but policy checks failed.', tx, false);
    return ok(tx);
  } catch (error) {
    return fail('simulation_failed', error instanceof Error ? error.message : 'Failed to simulate transaction preview.', undefined, true);
  }
}

function handoffForTx(tx: TxPreview): Record<string, unknown> {
  return {
    chainId: tx.chainId,
    from: tx.from,
    to: tx.to,
    value: tx.value,
    data: tx.data,
    decoded: tx.decoded,
    warning: 'Unsigned handoff only. Review in your Safe before signing.'
  };
}

async function submitWithDevPrivateKeyFork(tx: TxPreview, deps: TxDeps, auditBase: Record<string, unknown>): Promise<OneHiveToolResult<TxSubmitOutput>> {
  if (tx.chainId !== 31337) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'fork_chain_required' }, deps.auditLogPath);
    return fail('fork_chain_required', 'dev-private-key execution is only enabled for local fork chain ID 31337.', { auditLogPath }, false);
  }
  const client = deps.client ?? createChainClientFromEnv(tx.chainId);
  const activeChainId = await client.getChainId();
  if (activeChainId !== 31337) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'wrong_fork_chain', activeChainId }, deps.auditLogPath);
    return fail('wrong_fork_chain', `Fork execution requires active chain 31337; RPC reported ${activeChainId}.`, { auditLogPath, activeChainId }, false);
  }
  const privateKey = deps.devPrivateKey ?? (process.env.FORK_PRIVATE_KEY as HexData | undefined) ?? (process.env.DEV_PRIVATE_KEY as HexData | undefined);
  if (!privateKey || !/^0x[a-fA-F0-9]{64}$/.test(privateKey)) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'missing_fork_private_key' }, deps.auditLogPath);
    return fail('missing_fork_private_key', 'FORK_PRIVATE_KEY or DEV_PRIVATE_KEY is required for dev-private-key fork execution.', { auditLogPath }, false);
  }
  if (!client.sendTransaction) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'send_unavailable' }, deps.auditLogPath);
    return fail('send_unavailable', 'The active chain client does not support transaction sending.', { auditLogPath }, false);
  }
  const txHash = await client.sendTransaction(tx, privateKey);
  const auditLogPath = await appendAudit({ ...auditBase, status: 'submitted', txHash }, deps.auditLogPath);
  return ok({ status: 'submitted', mode: 'dev-private-key', txHash, auditLogPath, handoff: { chainId: tx.chainId, to: tx.to, value: tx.value, data: `[${tx.data.length} chars]` } }, ['Transaction was submitted only because dev-private-key was used on local fork chain 31337.']);
}

async function submitWithSafe(tx: TxPreview, input: TxSubmitInput, deps: TxDeps, auditBase: Record<string, unknown>): Promise<OneHiveToolResult<TxSubmitOutput>> {
  const output: TxSubmitOutput = { status: 'proposed', mode: 'safe', handoff: handoffForTx(tx) };
  const url = safeUrl(input.safeAddress, tx);
  if (url) output.safeUrl = url;
  output.auditLogPath = await appendAudit({ ...auditBase, status: 'proposed', handoff: { ...output.handoff, data: `[${tx.data.length} chars]` } }, deps.auditLogPath);
  return ok(output, ['Unsigned handoff only: no transaction was signed or submitted by this tool.']);
}

async function submitWithKeystore(tx: TxPreview, input: TxSubmitInput, deps: TxDeps, auditBase: Record<string, unknown>): Promise<OneHiveToolResult<TxSubmitOutput>> {
  if (!tx.from) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'missing_from' }, deps.auditLogPath);
    return fail('missing_from', 'Encrypted keystore signing requires tx.from to be set.', { auditLogPath }, false);
  }
  const identifier = input.keystoreAccount ?? input.keystoreLabel ?? tx.from;
  try {
    const metadata = await resolveKeystore(identifier, deps.keystoreDir);
    if (metadata.address.toLowerCase() !== tx.from.toLowerCase()) {
      const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'keystore_from_mismatch', keystoreAddress: metadata.address, keystoreLabel: metadata.label }, deps.auditLogPath);
      return fail('keystore_from_mismatch', `Encrypted keystore ${metadata.label} (${metadata.address}) does not match tx.from ${tx.from}.`, { auditLogPath }, false);
    }
    const policy = await loadKeystorePolicy(deps.keystorePolicyPath);
    const policyChecks = evaluateKeystorePolicy({ policy, tx, account: metadata.address });
    if (hasFailedPolicy(policyChecks)) {
      const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'keystore_policy_blocked', keystoreAddress: metadata.address, keystoreLabel: metadata.label, checks: policyChecks }, deps.auditLogPath);
      return fail('keystore_policy_blocked', 'Encrypted keystore signing blocked by keystore policy.', { checks: policyChecks, auditLogPath }, false);
    }
    const passphrase = deps.keystorePassphrase
      ?? await deps.keystorePassphraseProvider?.(metadata.label)
      ?? (process.env.HONEY_KEYSTORE_ALLOW_PASSPHRASE_FILE === '1' ? await readPassphraseFromFile() : await readPassphraseInteractively(metadata.label));
    const decrypted = await decryptKeystore(metadata.path, passphrase);
    if (decrypted.address.toLowerCase() !== tx.from.toLowerCase()) {
      const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'keystore_decrypt_mismatch', keystoreAddress: decrypted.address, keystoreLabel: decrypted.label }, deps.auditLogPath);
      return fail('keystore_decrypt_mismatch', 'Decrypted keystore account does not match tx.from.', { auditLogPath }, false);
    }
    const client = deps.client ?? createChainClientFromEnv(tx.chainId);
    if (!client.sendTransaction) {
      const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'send_unavailable' }, deps.auditLogPath);
      return fail('send_unavailable', 'The active chain client does not support transaction sending.', { auditLogPath }, false);
    }
    const txHash = await client.sendTransaction(tx, decrypted.privateKey);
    const auditLogPath = await appendAudit({ ...auditBase, status: 'submitted', mode: 'keystore', txHash, keystoreAddress: decrypted.address, keystoreLabel: decrypted.label, checks: policyChecks }, deps.auditLogPath);
    return ok({ status: 'submitted', mode: 'keystore', txHash, auditLogPath, handoff: { chainId: tx.chainId, from: tx.from, to: tx.to, value: tx.value, data: `[${tx.data.length} chars]`, keystore: { address: decrypted.address, label: decrypted.label } } }, ['Transaction was signed by a local encrypted keystore after confirmation, submit-time preflight, and keystore policy checks.']);
  } catch (error) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'keystore_failed', error: error instanceof Error ? error.message : 'Encrypted keystore signing failed.' }, deps.auditLogPath);
    return fail('keystore_failed', error instanceof Error ? error.message : 'Encrypted keystore signing failed.', { auditLogPath }, false);
  }
}

async function submitWithExternalSigner(tx: TxPreview, input: TxSubmitInput, deps: TxDeps, auditBase: Record<string, unknown>, verified: Awaited<ReturnType<typeof preflightSubmitPreview>>): Promise<OneHiveToolResult<TxSubmitOutput>> {
  const requestId = createHash('sha256').update(JSON.stringify({ chainId: tx.chainId, from: tx.from, to: tx.to, value: tx.value, data: tx.data, mode: input.signerMode })).digest('hex').slice(0, 24);
  try {
    const request = buildSignerRequest({
      requestId,
      tx,
      confirmationPhrase: input.confirmationPhrase,
      preflight: { activeChainId: Number(verified.activeChainId), selector: verified.selector, checks: verified.checks },
      ...(tx.from ? { account: tx.from } : {}),
      ...(input.keystoreLabel ?? input.keystoreAccount ? { label: input.keystoreLabel ?? input.keystoreAccount } : {})
    });
    const response = await (deps.externalSignerRequest ?? requestExternalSignature)(request, { ...(input.externalSignerUrl ? { url: input.externalSignerUrl } : {}), ...(input.externalSignerSocket ? { socketPath: input.externalSignerSocket } : {}) });
    if (response.status === 'submitted') {
      const auditLogPath = await appendAudit({ ...auditBase, status: 'submitted', mode: 'external-signer', txHash: response.txHash, signerAuditId: response.signerAuditId, requestId }, deps.auditLogPath);
      return ok({ status: 'submitted', mode: input.signerMode ?? 'external-signer', txHash: response.txHash!, auditLogPath, handoff: { signer: 'external', requestId, signerAuditId: response.signerAuditId } }, ['Transaction was submitted by an external Honey signer after submit preflight and signer policy checks.']);
    }
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', mode: 'external-signer', reason: response.status, signerAuditId: response.signerAuditId, requestId }, deps.auditLogPath);
    return fail(response.status === 'ambiguous' ? 'external_signer_ambiguous' : 'external_signer_rejected', response.message ?? `External signer returned ${response.status}.`, { auditLogPath, requestId, signerAuditId: response.signerAuditId }, response.retryable ?? response.status === 'ambiguous');
  } catch (error) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', mode: 'external-signer', reason: 'external_signer_failed', error: error instanceof Error ? error.message : 'External signer failed.', requestId }, deps.auditLogPath);
    return fail('external_signer_failed', error instanceof Error ? error.message : 'External signer failed.', { auditLogPath, requestId }, true);
  }
}

export async function submitTxPreview(input: TxSubmitInput, deps: TxDeps = {}): Promise<OneHiveToolResult<TxSubmitOutput>> {
  const signerMode = input.signerMode ?? 'safe';
  const now = deps.now ?? new Date();
  const auditBase = { at: now.toISOString(), tool: 'onehive_tx_submit', mode: signerMode, tx: redactedTx(input.tx) };
  const expectedConfirmationPhrase = generateConfirmationPhrase(input.tx);

  if (input.confirmationPhrase !== input.tx.policy.confirmationPhrase || input.confirmationPhrase !== expectedConfirmationPhrase) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'confirmation_mismatch' }, deps.auditLogPath);
    return fail('confirmation_mismatch', 'Confirmation phrase did not exactly match the transaction preview.', { auditLogPath }, false);
  }
  if (signerMode === 'dev-private-key' && input.tx.chainId === 100) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'dev_private_key_mainnet' }, deps.auditLogPath);
    return fail('signer_mode_blocked', 'dev-private-key signer mode is blocked on Gnosis mainnet.', { auditLogPath }, false);
  }
  if (signerMode === 'ledger') {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'ledger_not_implemented' }, deps.auditLogPath);
    return fail('handoff_not_supported', 'Ledger handoff is not implemented yet; use safe.', { auditLogPath }, false);
  }

  if (!['safe', 'keystore', 'dev-private-key', 'external-signer', 'signer-daemon'].includes(signerMode)) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'unsupported_signer_mode' }, deps.auditLogPath);
    return fail('handoff_not_supported', 'Unsupported signer mode. No transaction was submitted.', { auditLogPath }, false);
  }
  const verified = await preflightSubmitPreview({ tx: input.tx, signerMode, ...(deps.client ? { client: deps.client } : {}) });
  if (hasFailedPolicy(verified.checks)) {
    const auditLogPath = await appendAudit({ ...auditBase, status: 'rejected', reason: 'policy_blocked', activeChainId: verified.activeChainId, checks: verified.checks }, deps.auditLogPath);
    return fail('policy_blocked', 'Transaction submission blocked by recomputed policy checks. Request a fresh preview if the transaction has changed or simulation is stale.', { checks: verified.checks, auditLogPath }, false);
  }
  const tx = verified.tx;

  if (signerMode === 'dev-private-key') return submitWithDevPrivateKeyFork(tx, deps, auditBase);
  if (signerMode === 'keystore') return submitWithKeystore(tx, input, deps, auditBase);
  if (signerMode === 'external-signer' || signerMode === 'signer-daemon') return submitWithExternalSigner(tx, input, deps, auditBase, verified);
  return submitWithSafe(tx, input, deps, auditBase);

}

export const txSimulateTool: ToolDefinition<TxSimulateInput, TxPreview> = {
  name: 'onehive_tx_simulate',
  description: 'Run eth_call/gas estimation against an unsigned transaction preview.',
  inputSchema: { type: 'object', required: ['tx'], additionalProperties: false, properties: { tx: { type: 'object' }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => simulateTxPreview(input)
};

export const txSubmitTool: ToolDefinition<TxSubmitInput, TxSubmitOutput> = {
  name: 'onehive_tx_submit',
  description: 'Submit or hand off a transaction preview after exact confirmation phrase matching and policy checks.',
  inputSchema: {
    type: 'object',
    required: ['tx', 'confirmationPhrase'],
    additionalProperties: false,
    properties: {
      tx: { type: 'object' },
      confirmationPhrase: { type: 'string' },
      signerMode: { enum: ['safe', 'ledger', 'dev-private-key', 'keystore', 'external-signer', 'signer-daemon'] },
      safeAddress: { type: 'string', pattern: addressPattern },
      keystoreAccount: { type: 'string' },
      keystoreLabel: { type: 'string' },
      externalSignerUrl: { type: 'string' },
      externalSignerSocket: { type: 'string' }
    }
  },
  handler: (input) => submitTxPreview(input)
};
