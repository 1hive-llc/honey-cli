import { describe, expect, it } from 'vitest';
import { HONEYSWAP } from '../../src/onehive/addresses.js';
import { buildTxPreview } from '../../src/onehive/clients/tx.js';
import { buildSignerRequest, previewHash, signerRequestSchema, signerResponseSchema } from '../../src/onehive/signer-protocol.js';
import type { HexAddress, HexData } from '../../src/onehive/schemas.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;

function tx() {
  const preview = buildTxPreview({ chainId: 100, from, to: HONEYSWAP.ROUTER, data: '0x38ed1739' as HexData, contractName: 'HoneyswapRouter02', method: 'swapExactTokensForTokens', args: {}, humanSummary: 'Swap', risk: 'high' });
  preview.simulation = { status: 'success', gasEstimate: '1' };
  return preview;
}

describe('signer protocol', () => {
  it('builds valid requests without raw confirmation phrases', () => {
    const request = buildSignerRequest({ requestId: 'request-1', tx: tx(), confirmationPhrase: 'SUBMIT secret-ish phrase', preflight: { activeChainId: 100, selector: { abiLockStatus: 'match', methodSelectorKnown: true, decodedMethodMatches: true, selector: '0x38ed1739', lockedMethod: 'swapExactTokensForTokens' }, checks: [] }, account: from });

    expect(request.previewHash).toBe(previewHash(tx()));
    expect(JSON.stringify(request)).not.toContain('SUBMIT secret-ish phrase');
    expect(signerRequestSchema.parse(request)).toMatchObject({ action: 'submit', account: from });
  });

  it('rejects secret-looking fields and mismatched preview hashes', () => {
    const request = buildSignerRequest({ requestId: 'request-2', tx: tx(), confirmationPhrase: 'SUBMIT', preflight: { activeChainId: 100, selector: { abiLockStatus: 'match', methodSelectorKnown: true, decodedMethodMatches: true }, checks: [] }, account: from }) as Record<string, unknown>;

    expect(() => signerRequestSchema.parse({ ...request, privateKey: '0xabc' })).toThrow(/privateKey|private-key|passphrase|mnemonic|seed|password/i);
    expect(() => signerRequestSchema.parse({ ...request, previewHash: '0'.repeat(64) })).toThrow(/previewHash/);
  });

  it('validates signer responses', () => {
    expect(() => signerResponseSchema.parse({ version: 1, requestId: 'request-3', status: 'submitted' })).toThrow(/txHash/);
    expect(signerResponseSchema.parse({ version: 1, requestId: 'request-3', status: 'submitted', txHash: '0xabc' })).toMatchObject({ status: 'submitted' });
    expect(() => signerResponseSchema.parse({ version: 1, requestId: 'request-3', status: 'rejected', passphrase: 'oops' })).toThrow(/private-key|passphrase|mnemonic|seed|password/i);
  });
});
