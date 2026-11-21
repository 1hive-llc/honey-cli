import { describe, expect, it } from 'vitest';
import { HONEYSWAP, buildSignerRequest, buildTxPreview, fail, ok, previewHash, signerRequestSchema, signerResponseSchema } from '../../src/onehive/index.js';
import type { HexAddress, HexData, ToolWarning, TxPreview } from '../../src/onehive/index.js';
import { runHoneyCli } from '../../src/honey-cli.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } }
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

function samplePreview(): TxPreview {
  const preview = buildTxPreview({
    chainId: 100,
    from,
    to: HONEYSWAP.ROUTER,
    value: '0',
    data: '0x38ed1739' as HexData,
    contractName: 'HoneyswapRouter02',
    method: 'swapExactTokensForTokens',
    args: { amountIn: '1' },
    humanSummary: 'Swap HNY through Honeyswap',
    risk: 'high',
    checks: [{ name: 'allowlisted target', status: 'pass', detail: 'router is allowlisted' }]
  });
  preview.simulation = { status: 'success', gasEstimate: '21000' };
  return preview;
}

describe('stable automation contracts', () => {
  it('keeps OneHiveToolResult success and failure JSON envelopes stable', () => {
    const success = ok({ value: 1 }, ['Collateral-risking action requires operator review.']);
    expect(success).toMatchObject({ ok: true, data: { value: 1 }, warnings: [expect.any(String)] });
    expect(success.error).toBeUndefined();
    expect(success.warningDetails?.[0]).toMatchObject<ToolWarning>({ category: 'security', severity: 'critical', message: expect.any(String) });

    const failure = fail('policy_rejected', 'Policy check failed.', { check: 'selector' }, false);
    expect(failure).toMatchObject({ ok: false, warnings: [], warningDetails: [], error: { code: 'policy_rejected', message: 'Policy check failed.', retryable: false, details: { check: 'selector' } } });
    expect(failure.data).toBeUndefined();
  });

  it('keeps TxPreview required fields and submit-display assumptions stable', () => {
    const preview = samplePreview();
    expect(preview).toMatchObject({
      chainId: 100,
      from,
      to: HONEYSWAP.ROUTER,
      value: '0',
      data: expect.stringMatching(/^0x[a-fA-F0-9]+$/),
      decoded: { contractName: 'HoneyswapRouter02', method: 'swapExactTokensForTokens', args: expect.any(Object), humanSummary: expect.any(String) },
      simulation: { status: 'success', gasEstimate: '21000' },
      policy: { risk: 'high', requiresConfirmation: true, confirmationPhrase: expect.stringContaining('SUBMIT'), checks: expect.any(Array) }
    });
    expect(preview.policy.checks[0]).toMatchObject({ name: 'allowlisted target', status: 'pass', detail: expect.any(String) });
  });

  it('keeps signer protocol v1 redacted and hash-bound', () => {
    const tx = samplePreview();
    const request = buildSignerRequest({
      requestId: 'request-contract-1',
      tx,
      confirmationPhrase: tx.policy.confirmationPhrase,
      account: from,
      preflight: {
        activeChainId: 100,
        selector: { selector: '0x38ed1739', lockedMethod: 'swapExactTokensForTokens', abiLockStatus: 'match', methodSelectorKnown: true, decodedMethodMatches: true },
        checks: tx.policy.checks
      }
    });

    expect(request.version).toBe(1);
    expect(request.previewHash).toBe(previewHash(tx));
    expect(request.confirmationPhraseHash).toMatch(/^[a-f0-9]{64}$/);
    expect(request.tx.policy.confirmationPhrase).toBe('[REDACTED]');
    expect(JSON.stringify(request)).not.toContain(tx.policy.confirmationPhrase);
    expect(signerRequestSchema.parse(request)).toMatchObject({ action: 'submit', account: from });
    expect(signerResponseSchema.parse({ version: 1, requestId: 'request-contract-1', status: 'submitted', txHash: '0xabc' })).toMatchObject({ status: 'submitted' });
  });

  it('keeps CLI --json output as a single result object and exit codes 0/non-zero stable', async () => {
    const success = capture();
    const successCode = await runHoneyCli(['signer', 'status', '--pid-file', '/tmp/nonexistent-honey-signer-contract.pid', '--json'], success.io);
    expect(successCode).toBe(0);
    expect(success.stderr).toBe('');
    const successParsed = JSON.parse(success.stdout);
    expect(successParsed).toMatchObject({ ok: true, data: { running: false } });
    expect(success.stdout.trim()).toMatch(/^\{[\s\S]*\}$/);

    const help = capture();
    await expect(runHoneyCli(['--help'], help.io)).resolves.toBe(0);
    expect(help.stderr).toContain('Usage: honey');

    const failure = capture();
    const failureCode = await runHoneyCli(['tool', 'missing_tool', '{}', '--json'], failure.io);
    expect(failureCode).toBe(1);
    expect(failure.stderr).toContain('Unknown tool missing_tool');
  });
});
