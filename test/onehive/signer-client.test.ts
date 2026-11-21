import { describe, expect, it, vi } from 'vitest';
import { HONEYSWAP } from '../../src/onehive/addresses.js';
import { buildTxPreview } from '../../src/onehive/clients/tx.js';
import { requestExternalSignature } from '../../src/onehive/signer-client.js';
import { buildSignerRequest } from '../../src/onehive/signer-protocol.js';
import type { HexAddress, HexData } from '../../src/onehive/schemas.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;

function request() {
  const tx = buildTxPreview({ chainId: 100, from, to: HONEYSWAP.ROUTER, data: '0x38ed1739' as HexData, contractName: 'HoneyswapRouter02', method: 'swapExactTokensForTokens', args: {}, humanSummary: 'Swap', risk: 'high' });
  return buildSignerRequest({ requestId: 'request-1', tx, confirmationPhrase: 'SUBMIT', preflight: { activeChainId: 100, selector: { abiLockStatus: 'match', methodSelectorKnown: true, decodedMethodMatches: true }, checks: [] }, account: from });
}

describe('external signer client', () => {
  it('returns validated submitted responses', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ version: 1, requestId: 'request-1', status: 'submitted', txHash: '0xabc' }), { status: 200 }));
    const result = await requestExternalSignature(request(), { fetchImpl, url: 'http://signer.local' });

    expect(result).toMatchObject({ status: 'submitted', txHash: '0xabc' });
    expect(fetchImpl).toHaveBeenCalledWith('http://signer.local/v1/sign', expect.objectContaining({ method: 'POST' }));
  });

  it('rejects mismatched request IDs and malformed responses', async () => {
    await expect(requestExternalSignature(request(), { url: 'http://signer.local', fetchImpl: async () => new Response(JSON.stringify({ version: 1, requestId: 'other-request', status: 'rejected' }), { status: 200 }) })).rejects.toThrow(/requestId/);
    await expect(requestExternalSignature(request(), { url: 'http://signer.local', fetchImpl: async () => new Response('not json', { status: 200 }) })).rejects.toThrow(/malformed JSON/);
  });

  it('redacts signer endpoint secrets in errors', async () => {
    await expect(requestExternalSignature(request(), { url: 'https://test-user:fixture-password@example.invalid/signer', fetchImpl: async () => new Response('nope', { status: 500 }) })).rejects.toThrow(/%5BREDACTED%5D|\[REDACTED\]/);
  });
});
