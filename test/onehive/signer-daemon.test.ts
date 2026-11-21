import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { HONEYSWAP } from '../../src/onehive/addresses.js';
import type { ChainClient } from '../../src/onehive/clients/chain.js';
import { buildTxPreview } from '../../src/onehive/clients/tx.js';
import { handleSignerRequest } from '../../src/onehive/signer-daemon.js';
import { buildSignerRequest } from '../../src/onehive/signer-protocol.js';
import type { HexAddress, HexData } from '../../src/onehive/schemas.js';

const privateKey = `0x${'0123456789abcdef'.repeat(4)}` as HexData;
const address = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c' as HexAddress;

function fakeClient(options: { callFails?: boolean } = {}): ChainClient {
  return {
    chainId: 100,
    rpcUrl: 'mock://gnosis',
    async getChainId() { return 100; },
    async getBytecode() { return '0x6001' as HexData; },
    async readContract<T = unknown>() { throw new Error('not used'); },
    async simulateContract() { return { status: 'success' as const, gasEstimate: 1n }; },
    async call() { if (options.callFails) throw new Error('revert'); return '0x' as HexData; },
    async estimateGas() { return 1n; },
    async sendTransaction() { return '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as HexData; }
  };
}

function tx(to: HexAddress = HONEYSWAP.ROUTER) {
  const preview = buildTxPreview({ chainId: 100, from: address, to, data: '0x38ed1739' as HexData, contractName: 'HoneyswapRouter02', method: 'swapExactTokensForTokens', args: {}, humanSummary: 'Swap', risk: 'high' });
  preview.simulation = { status: 'success', gasEstimate: '1' };
  return preview;
}

async function fixtures() {
  const dir = await mkdtemp(join(tmpdir(), 'onehive-signer-daemon-'));
  const policyPath = join(dir, 'policy.json');
  const auditLogPath = join(dir, 'audit.log');
  await writeFile(policyPath, JSON.stringify({ version: 1, accounts: [{ label: 'bot', address, allowedChainIds: [100], allowedTargets: [HONEYSWAP.ROUTER], allowedSelectors: ['0x38ed1739'], allowedMethods: ['swapExactTokensForTokens'], maxValueWei: '0', maxRisk: 'high' }] }), 'utf8');
  return { policyPath, auditLogPath };
}

function request(preview = tx()) {
  return buildSignerRequest({ requestId: 'request-1', tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, preflight: { activeChainId: 100, selector: { abiLockStatus: 'match', methodSelectorKnown: true, decodedMethodMatches: true, selector: '0x38ed1739', lockedMethod: 'swapExactTokensForTokens' }, checks: [] }, account: address, label: 'bot' });
}

describe('honey signer daemon', () => {
  it('submits allowed signer requests and redacts secrets from audit logs', async () => {
    const { policyPath, auditLogPath } = await fixtures();
    const result = await handleSignerRequest(request(), { address, label: 'bot', privateKey }, { client: fakeClient(), policyPath, auditLogPath });

    expect(result).toMatchObject({ status: 'submitted', txHash: expect.stringMatching(/^0xaaaa/) });
    const log = await readFile(auditLogPath, 'utf8');
    expect(log).not.toContain(privateKey.slice(2));
  });

  it('rejects wrong targets and simulation failures', async () => {
    const { policyPath, auditLogPath } = await fixtures();
    const wrongTarget = await handleSignerRequest(request(tx('0x0000000000000000000000000000000000000001' as HexAddress)), { address, label: 'bot', privateKey }, { client: fakeClient(), policyPath, auditLogPath });
    expect(wrongTarget.status).toBe('rejected');

    const simulation = await handleSignerRequest(request(), { address, label: 'bot', privateKey }, { client: fakeClient({ callFails: true }), policyPath, auditLogPath });
    expect(simulation.status).toBe('rejected');
  });
});
