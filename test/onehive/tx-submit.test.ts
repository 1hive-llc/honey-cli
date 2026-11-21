import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HONEYSWAP } from '../../src/onehive/addresses.js';
import type { ChainClient } from '../../src/onehive/clients/chain.js';
import { buildTxPreview } from '../../src/onehive/clients/tx.js';
import { createEncryptedKeystore } from '../../src/onehive/keystore.js';
import { simulateTxPreview, submitTxPreview } from '../../src/onehive/tools/tx-submit.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;
const safe = '0x2222222222222222222222222222222222222222' as HexAddress;
const keystorePrivateKey = `0x${'0123456789abcdef'.repeat(4)}` as HexData;
const keystoreAddress = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c' as HexAddress;

function tx(overrides: Partial<TxPreview> = {}): TxPreview {
  const preview = buildTxPreview({
    chainId: 100,
    from,
    to: HONEYSWAP.ROUTER,
    data: '0x38ed17390000000000000000000000000000000000000000000000000000000000000000' as HexData,
    contractName: 'HoneyswapRouter02',
    method: 'swapExactTokensForTokens',
    args: {},
    humanSummary: 'Swap preview.',
    risk: 'high'
  });
  preview.simulation = { status: 'success', gasEstimate: '12345' };
  preview.policy.checks = [
    { name: 'allowlisted-target', status: 'pass', detail: 'Target is allowlisted.' },
    { name: 'target-bytecode', status: 'pass', detail: 'Target bytecode present.' },
    { name: 'selector-known', status: 'pass', detail: 'Selector known.' },
    { name: 'abi-lock', status: 'pass', detail: 'ABI lock matches reviewed metadata.' },
    { name: 'simulation', status: 'pass', detail: 'Simulation succeeded.' }
  ];
  return { ...preview, ...overrides };
}

type FakeOptions = { chainId?: number; bytecode?: HexData | undefined; callFails?: boolean; gasFails?: boolean; txHash?: HexData };
function fakeClient(options: FakeOptions = {}): ChainClient {
  return {
    chainId: 100,
    rpcUrl: 'mock://gnosis',
    async getChainId() { return options.chainId ?? 100; },
    async getBytecode() { return options.bytecode === undefined ? '0x60016000' as HexData : options.bytecode; },
    async readContract<T = unknown>() { throw new Error('not used'); },
    async simulateContract() { return { status: 'success' as const, gasEstimate: 12345n }; },
    async call() { if (options.callFails) throw new Error('execution reverted: nope'); return '0x' as HexData; },
    async estimateGas() { if (options.gasFails) throw new Error('gas failed'); return 12345n; },
    async sendTransaction() { return options.txHash ?? '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as HexData; }
  };
}

async function auditPath() {
  const dir = await mkdtemp(join(tmpdir(), 'onehive-audit-'));
  return join(dir, 'audit.log');
}

describe('transaction simulation and handoff', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it('simulates a transaction preview with eth_call and gas estimate', async () => {
    const result = await simulateTxPreview({ tx: tx({ simulation: { status: 'not-run' } }) }, { client: fakeClient(), auditLogPath: await auditPath() });

    expect(result.ok).toBe(true);
    expect(result.data?.simulation).toEqual({ status: 'success', gasEstimate: '12345' });
    expect(result.data?.policy.checks.some((check) => check.name === 'target-bytecode' && check.status === 'pass')).toBe(true);
  });

  it('returns structured failure on simulation revert', async () => {
    const result = await simulateTxPreview({ tx: tx({ simulation: { status: 'not-run' } }) }, { client: fakeClient({ callFails: true }), auditLogPath: await auditPath() });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('simulation_reverted');
    expect(result.error?.details).toMatchObject({ simulation: { status: 'revert' } });
  });

  it('fails wrong chain simulation', async () => {
    const result = await simulateTxPreview({ tx: tx() }, { client: fakeClient({ chainId: 10200 }), auditLogPath: await auditPath() });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('wrong_chain');
  });

  it('fails closed when target bytecode is missing', async () => {
    const result = await simulateTxPreview({ tx: tx({ simulation: { status: 'not-run' } }) }, { client: fakeClient({ bytecode: '0x' }), auditLogPath: await auditPath() });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_blocked');
    expect(result.error?.details).toMatchObject({ policy: { checks: expect.any(Array) } });
  });

  it('rejects confirmation mismatch and appends audit', async () => {
    const path = await auditPath();
    const result = await submitTxPreview({ tx: tx(), confirmationPhrase: 'wrong', signerMode: 'safe' }, { auditLogPath: path });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('confirmation_mismatch');
    expect(await readFile(path, 'utf8')).toContain('confirmation_mismatch');
  });

  it('blocks dev private key mode on mainnet', async () => {
    const path = await auditPath();
    const result = await submitTxPreview({ tx: tx(), confirmationPhrase: tx().policy.confirmationPhrase, signerMode: 'dev-private-key' }, { auditLogPath: path });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('signer_mode_blocked');
  });

  it('recomputes simulation before handoff instead of trusting stale preview status', async () => {
    const path = await auditPath();
    const staleTx = tx({ simulation: { status: 'not-run' } });
    const result = await submitTxPreview({ tx: staleTx, confirmationPhrase: staleTx.policy.confirmationPhrase, safeAddress: safe }, { client: fakeClient(), auditLogPath: path });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('proposed');
  });

  it('blocks when recomputed submit-time simulation reverts despite forged preview success', async () => {
    const path = await auditPath();
    const forged = tx({ simulation: { status: 'success', gasEstimate: '999999' } });
    const result = await submitTxPreview({ tx: forged, confirmationPhrase: forged.policy.confirmationPhrase, signerMode: 'safe' }, { client: fakeClient({ callFails: true }), auditLogPath: path });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_blocked');
    expect(result.error?.details).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ name: 'simulation', status: 'fail' })]) });
  });

  it('blocks forged preview policy checks when calldata selector is not ABI-locked', async () => {
    const path = await auditPath();
    const forged = tx({ data: '0xdeadbeef' as HexData });
    const result = await submitTxPreview({ tx: forged, confirmationPhrase: forged.policy.confirmationPhrase, signerMode: 'safe' }, { client: fakeClient(), auditLogPath: path });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('policy_blocked');
    expect(result.error?.details).toMatchObject({ checks: expect.arrayContaining([expect.objectContaining({ name: 'abi-lock', status: 'fail' }), expect.objectContaining({ name: 'selector-known', status: 'fail' })]) });
  });

  it('returns a Safe handoff without signing when no signer is selected', async () => {
    const path = await auditPath();
    const preview = tx();
    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, safeAddress: safe }, { client: fakeClient(), auditLogPath: path });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('proposed');
    expect(result.data?.safeUrl).toContain('app.safe.global');
    expect(result.data?.handoff).toMatchObject({ to: HONEYSWAP.ROUTER, value: '0' });
    const log = await readFile(path, 'utf8');
    expect(log).toContain('proposed');
    expect(log).not.toContain(preview.policy.confirmationPhrase);
  });

  it('rejects unsupported signer modes from untyped JSON without a handoff', async () => {
    const preview = tx();
    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'walletconnect' as never }, { client: fakeClient(), auditLogPath: await auditPath() });
    expect(result.error?.code).toBe('handoff_not_supported');
    expect(result.data).toBeUndefined();
  });

  it('reports malformed receipt RPC responses clearly', async () => {
    const { waitForTxReceipt } = await import('../../src/onehive/tools/tx-submit.js');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>bad gateway</html>', { status: 502, statusText: 'Bad Gateway' })));

    await expect(waitForTxReceipt({ chainId: 100, txHash: '0xabc', timeoutMs: 1, pollIntervalMs: 1 })).rejects.toThrow(/HTTP 502/);
  });

  it('reports missing JSON-RPC result fields clearly', async () => {
    const { waitForTxReceipt } = await import('../../src/onehive/tools/tx-submit.js');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1 }), { status: 200 })));

    await expect(waitForTxReceipt({ chainId: 100, txHash: '0xabc', timeoutMs: 1, pollIntervalMs: 1 })).rejects.toThrow(/missing result/);
  });

  it('submits with dev-private-key only on local fork chain', async () => {
    const path = await auditPath();
    const preview = tx({ chainId: 31337 });
    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'dev-private-key' }, {
      auditLogPath: path,
      client: fakeClient({ chainId: 31337 }),
      devPrivateKey: keystorePrivateKey
    });

    expect(result.ok).toBe(true);
    expect(result.data?.status).toBe('submitted');
    expect(result.data?.txHash).toMatch(/^0xaaaa/);
    const log = await readFile(path, 'utf8');
    expect(log).toContain('submitted');
    expect(log).not.toContain('0123456789abcdef');
  });

  it('signs with encrypted keystore only after policy authorization', async () => {
    const path = await auditPath();
    const dir = await mkdtemp(join(tmpdir(), 'onehive-keystore-submit-'));
    await createEncryptedKeystore({ dir, label: 'bot', privateKey: keystorePrivateKey, passphrase: 'secret' });
    const policyPath = join(dir, 'policy.json');
    await writeFile(policyPath, JSON.stringify({ version: 1, accounts: [{ label: 'bot', address: keystoreAddress, allowedChainIds: [100], allowedTargets: [HONEYSWAP.ROUTER], allowedSelectors: ['0x38ed1739'], allowedMethods: ['swapExactTokensForTokens'], maxValueWei: '0', maxRisk: 'high' }] }), 'utf8');
    const preview = tx({ from: keystoreAddress });

    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'keystore', keystoreAccount: 'bot' }, {
      auditLogPath: path,
      client: fakeClient(),
      keystoreDir: dir,
      keystorePolicyPath: policyPath,
      keystorePassphrase: 'secret'
    });

    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe('keystore');
    expect(result.data?.txHash).toMatch(/^0xaaaa/);
    const log = await readFile(path, 'utf8');
    expect(log).toContain('keystore');
    expect(log).not.toContain('0123456789abcdef');
    expect(log).not.toContain('secret');
  });

  it('submits through an external signer without local keystore secrets', async () => {
    const path = await auditPath();
    const preview = tx();
    let called = false;
    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'signer-daemon' }, {
      auditLogPath: path,
      client: fakeClient(),
      externalSignerRequest: async (request) => {
        called = true;
        expect(request.tx.to).toBe(HONEYSWAP.ROUTER);
        expect(JSON.stringify(request)).not.toContain(preview.policy.confirmationPhrase);
        return { version: 1, requestId: request.requestId, status: 'submitted', txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' };
      }
    });

    expect(called).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.data?.mode).toBe('signer-daemon');
    expect(result.data?.txHash).toMatch(/^0xdddd/);
  });

  it('surfaces external signer rejections', async () => {
    const path = await auditPath();
    const preview = tx();
    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'external-signer' }, {
      auditLogPath: path,
      client: fakeClient(),
      externalSignerRequest: async (request) => ({ version: 1, requestId: request.requestId, status: 'rejected', message: 'policy denied' })
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('external_signer_rejected');
  });

  it('blocks encrypted keystore signing before decrypting when policy is missing', async () => {
    const path = await auditPath();
    const dir = await mkdtemp(join(tmpdir(), 'onehive-keystore-submit-'));
    await createEncryptedKeystore({ dir, label: 'bot', privateKey: keystorePrivateKey, passphrase: 'secret' });
    const preview = tx({ from: keystoreAddress });

    const result = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'keystore', keystoreAccount: 'bot' }, {
      auditLogPath: path,
      client: fakeClient(),
      keystoreDir: dir,
      keystorePolicyPath: join(dir, 'missing-policy.json'),
      keystorePassphrase: 'secret'
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('keystore_failed');
  });
});
