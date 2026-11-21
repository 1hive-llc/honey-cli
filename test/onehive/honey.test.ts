import { describe, expect, it } from 'vitest';
import { maxUint256, parseUnits } from 'viem';
import { HONEYSWAP, TOKENS } from '../../src/onehive/addresses.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';
import {
  buildHoneyApprovalPreview,
  buildHoneyQuote,
  buildHoneySwapPreview,
  decodeHoneyQuoteId,
  unlimitedApprovalPhrase
} from '../../src/onehive/tools/honey.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;
const recipient = '0x2222222222222222222222222222222222222222' as HexAddress;
const pair = '0x4505b262DC053998C10685DC5F9098af8AE5C8ad' as HexAddress;
const nowMs = Date.parse('2026-06-22T00:00:00.000Z');

function tamperQuoteId(quoteId: string, mutate: (payload: Record<string, unknown>) => void): string {
  const payload = JSON.parse(Buffer.from(quoteId, 'base64url').toString('utf8')) as Record<string, unknown>;
  mutate(payload);
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

type FakeOptions = {
  chainId?: number;
  allowance?: bigint;
  simulation?: { status: 'success'; gasEstimate?: bigint } | { status: 'revert'; revertReason?: string };
  amountOut?: bigint;
  highImpact?: boolean;
};

function fakeClient(options: FakeOptions = {}): ChainClient & { calls: string[] } {
  const calls: string[] = [];
  const amountOut = options.amountOut ?? 99n * 10n ** 18n;
  return {
    calls,
    chainId: 100,
    rpcUrl: 'mock://gnosis',
    async getChainId() {
      calls.push('getChainId');
      return options.chainId ?? 100;
    },
    async getBytecode() {
      calls.push('getBytecode');
      return '0x60016000' as HexData;
    },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      calls.push(`read:${request.functionName}`);
      if (request.functionName === 'decimals') return 18 as T;
      if (request.functionName === 'getAmountsOut') return [parseUnits('1', 18), amountOut] as T;
      if (request.functionName === 'getAmountsIn') return [parseUnits('1.02', 18), parseUnits('100', 18)] as T;
      if (request.functionName === 'getPair') return pair as T;
      if (request.functionName === 'getReserves') {
        return options.highImpact
          ? [parseUnits('1', 18), parseUnits('1000', 18), 1] as T
          : [parseUnits('1000', 18), parseUnits('100000', 18), 1] as T;
      }
      if (request.functionName === 'token0') return TOKENS.WXDAI as T;
      if (request.functionName === 'allowance') return (options.allowance ?? parseUnits('10', 18)) as T;
      throw new Error(`Unexpected read ${request.functionName}`);
    },
    async simulateContract(_request: ContractSimulationRequest) {
      calls.push('simulate');
      return options.simulation ?? { status: 'success' as const, gasEstimate: 12345n };
    },
    async estimateGas(_tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>) {
      calls.push('estimateGas');
      return 12345n;
    }
  };
}

describe('Honey trading tools', () => {
  it('quotes exact-input HNY buy with reserves and expiry', async () => {
    const result = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });

    expect(result.ok).toBe(true);
    expect(result.data?.path).toEqual([TOKENS.WXDAI, TOKENS.HNY]);
    expect(result.data?.amountIn).toBe(parseUnits('1', 18).toString());
    expect(result.data?.estimatedAmountOut).toBe((99n * 10n ** 18n).toString());
    expect(result.data?.minimumAmountOut).toBe((9801n * 10n ** 16n).toString());
    expect(result.data?.quoteExpiresAt).toBe('2026-06-22T00:01:00.000Z');
    expect(decodeHoneyQuoteId(result.data!.quoteId).amountIn).toBe(result.data?.amountIn);
  });

  it('rejects high slippage quotes', async () => {
    const result = await buildHoneyQuote({ side: 'sell', exact: 'input', amount: '1', slippageBps: 501 }, { client: fakeClient(), nowMs });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('slippage_too_high');
  });

  it('rejects wrong RPC chain for quotes', async () => {
    const result = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1' }, { client: fakeClient({ chainId: 10200 }), nowMs });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('honey_quote_failed');
    expect(result.error?.message).toContain('connected to chain 10200');
  });

  it('builds exact approval calldata preview and simulates', async () => {
    const result = await buildHoneyApprovalPreview({ token: TOKENS.WXDAI, amount: '2', from }, { client: fakeClient(), nowMs });

    expect(result.ok).toBe(true);
    expect(result.data?.to).toBe(TOKENS.WXDAI);
    expect(result.data?.data).toMatch(/^0x095ea7b3/);
    expect(result.data?.simulation).toMatchObject({ status: 'success', gasEstimate: '12345' });
    expect(result.data?.policy.checks.some((check) => check.name === 'abi-lock' && check.status === 'pass')).toBe(true);
  });

  it('rejects unlimited approval without exact phrase', async () => {
    const result = await buildHoneyApprovalPreview({ token: TOKENS.HNY, amount: '0', unlimited: true, from }, { client: fakeClient(), nowMs });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('unlimited_approval_rejected');
  });

  it('allows unlimited approval with exact phrase and marks policy warning', async () => {
    const phrase = unlimitedApprovalPhrase(TOKENS.HNY, HONEYSWAP.ROUTER);
    const result = await buildHoneyApprovalPreview({ token: TOKENS.HNY, amount: '0', unlimited: true, unlimitedApprovalConfirmation: phrase, from }, { client: fakeClient(), nowMs });

    expect(result.ok).toBe(true);
    expect(result.data?.decoded.args.amount).toBe(maxUint256.toString());
    expect(result.data?.policy.checks.some((check) => check.name === 'unlimited-approval' && check.status === 'warn')).toBe(true);
  });

  it('rejects stale quote swap previews', async () => {
    const quote = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });
    const result = await buildHoneySwapPreview({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100, recipient, quoteId: quote.data!.quoteId, from }, { client: fakeClient(), nowMs: nowMs + 61_000 });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('stale_quote');
  });

  it('rejects missing allowance before swap simulation', async () => {
    const quote = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });
    const client = fakeClient({ allowance: 0n });
    const result = await buildHoneySwapPreview({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100, recipient, quoteId: quote.data!.quoteId, from }, { client, nowMs });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('missing_allowance');
    expect(client.calls).not.toContain('simulate');
  });

  it('rejects high price-impact swaps using a refreshed quote at swap-preview time', async () => {
    const quote = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });
    const result = await buildHoneySwapPreview({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100, recipient, quoteId: quote.data!.quoteId, from }, { client: fakeClient({ highImpact: true, amountOut: parseUnits('1', 18) }), nowMs });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('price_impact_too_high');
  });

  it('does not trust tampered quote payload amounts or omitted price impact', async () => {
    const quote = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });
    const tamperedQuoteId = tamperQuoteId(quote.data!.quoteId, (payload) => {
      payload.estimatedAmountOut = parseUnits('1000000', 18).toString();
      payload.minimumAmountOut = '1';
      delete payload.priceImpactBps;
    });
    const result = await buildHoneySwapPreview({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100, recipient, quoteId: tamperedQuoteId, from }, { client: fakeClient({ highImpact: true, amountOut: parseUnits('1', 18) }), nowMs });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('price_impact_too_high');
  });

  it('builds swap preview from a fresh quote', async () => {
    const quote = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });
    const result = await buildHoneySwapPreview({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100, recipient, quoteId: quote.data!.quoteId, from, deadlineMinutes: 10 }, { client: fakeClient(), nowMs });

    expect(result.ok).toBe(true);
    expect(result.data?.to).toBe(HONEYSWAP.ROUTER);
    expect(result.data?.data).toMatch(/^0x38ed1739/);
    expect(result.data?.decoded.args.recipient).toBe(recipient);
    expect(result.data?.decoded.args.deadline).toBe(String(Math.floor(nowMs / 1000) + 600));
    expect(result.data?.policy.checks.some((check) => check.name === 'quote-freshness' && check.status === 'pass')).toBe(true);
  });

  it('returns structured failure when swap simulation reverts', async () => {
    const quote = await buildHoneyQuote({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100 }, { client: fakeClient(), nowMs });
    const result = await buildHoneySwapPreview({ side: 'buy', exact: 'input', amount: '1', slippageBps: 100, recipient, quoteId: quote.data!.quoteId, from }, {
      client: fakeClient({ simulation: { status: 'revert', revertReason: 'Honeyswap: EXPIRED' } }),
      nowMs
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('simulation_reverted');
    expect(result.error?.details).toMatchObject({ simulation: { status: 'revert', revertReason: 'Honeyswap: EXPIRED' } });
  });
});
