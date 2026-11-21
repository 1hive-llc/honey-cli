import { describe, expect, it } from 'vitest';
import { HONEYSWAP } from '../../src/onehive/addresses.js';
import { detectLikelySecret, evaluateTxPolicy, generateConfirmationPhrase } from '../../src/onehive/policy.js';
import { ok } from '../../src/onehive/schemas.js';
import type { TxPreview } from '../../src/onehive/schemas.js';

function tx(overrides: Partial<TxPreview> = {}): TxPreview {
  return {
    chainId: 100,
    to: HONEYSWAP.ROUTER,
    value: '0',
    data: '0x',
    decoded: {
      contractName: 'HoneyswapRouter',
      method: 'swapExactETHForTokens',
      args: {},
      humanSummary: 'Swap xDAI for HNY.'
    },
    simulation: { status: 'success' },
    policy: {
      risk: 'medium',
      requiresConfirmation: true,
      confirmationPhrase: 'placeholder',
      checks: []
    },
    ...overrides
  };
}

describe('policy', () => {
  it('generates deterministic confirmation phrases', () => {
    expect(generateConfirmationPhrase(tx())).toBe('SUBMIT swapExactETHForTokens ON GNOSIS TO HoneyswapRouter 0x1C23...7f77 VALUE 0');
  });

  it('blocks dev private key mode on Gnosis mainnet but not local fork', () => {
    const mainnet = evaluateTxPolicy(tx(), { chainId: 100, signerMode: 'dev-private-key' });
    const fork = evaluateTxPolicy({ ...tx(), chainId: 31337 }, { chainId: 31337, signerMode: 'dev-private-key', allowTestnetWrites: true });

    expect(mainnet.some((check) => check.name === 'signer-mode' && check.status === 'fail')).toBe(true);
    expect(fork.some((check) => check.name === 'signer-mode' && check.status === 'fail')).toBe(false);
  });

  it('blocks stale quotes', () => {
    const checks = evaluateTxPolicy(tx(), { chainId: 100, quoteCreatedAtMs: 0, nowMs: 61_000, quoteTtlMs: 60_000 });
    expect(checks.some((check) => check.name === 'quote-freshness' && check.status === 'fail')).toBe(true);
  });

  it('blocks high price impact', () => {
    const checks = evaluateTxPolicy(tx(), { chainId: 100, priceImpactBps: 501, priceImpactHardCapBps: 500 });
    expect(checks.some((check) => check.name === 'price-impact' && check.status === 'fail')).toBe(true);
  });

  it('matches allowlisted write targets case-insensitively', () => {
    const checks = evaluateTxPolicy(tx({ to: HONEYSWAP.ROUTER.toLowerCase() as TxPreview['to'] }), { chainId: 100 });

    expect(checks.find((check) => check.name === 'allowlisted-target')?.status).toBe('pass');
  });

  it('enforces ABI lock status when provided', () => {
    const passing = evaluateTxPolicy(tx(), { chainId: 100, abiLockStatus: 'match' });
    const failing = evaluateTxPolicy(tx(), { chainId: 100, abiLockStatus: 'missing' });

    expect(passing.some((check) => check.name === 'abi-lock' && check.status === 'pass')).toBe(true);
    expect(failing.some((check) => check.name === 'abi-lock' && check.status === 'fail')).toBe(true);
  });

  it('blocks high slippage', () => {
    const checks = evaluateTxPolicy(tx(), { chainId: 100, slippageBps: 501, slippageHardCapBps: 500 });
    expect(checks.some((check) => check.name === 'slippage' && check.status === 'fail')).toBe(true);
  });

  it('blocks unconfirmed unlimited approvals', () => {
    const checks = evaluateTxPolicy(tx(), { chainId: 100, unlimitedApproval: true, unlimitedApprovalPhraseMatched: false });
    expect(checks.some((check) => check.name === 'unlimited-approval' && check.status === 'fail')).toBe(true);
  });

  it('adds structured warning details while preserving warning strings', () => {
    const result = ok({ ready: true }, ['Collateral risk: keeper penalties may apply.']);

    expect(result.warnings[0]).toContain('Collateral risk');
    expect(result.warningDetails?.[0]).toMatchObject({ category: 'security', severity: 'critical', message: result.warnings[0] });
  });

  it('detects likely secrets in diffs', () => {
    const dummySecret = `PRIVATE_KEY=0x${'0123456789abcdef'.repeat(4)}`;
    const findings = detectLikelySecret(dummySecret);
    expect(findings).toContain('private key');
  });
});
