import { encodeFunctionData, maxUint256, parseUnits } from 'viem';
import { erc20Abi } from '../abis/erc20.js';
import { honeyswapFactoryAbi, honeyswapPairAbi, honeyswapRouter02Abi } from '../abis/honeyswap.js';
import { HONEYSWAP, TOKENS } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { buildTxPreview } from '../clients/tx.js';
import type { ToolDefinition } from '../tool-types.js';
import { simulateContractPreviewWithPolicy } from './tx-preflight.js';
import { addressPattern, fail, ok, uintStringPattern, type ChainId, type HexAddress, type OneHiveToolResult, type TxPreview } from '../schemas.js';

const DEFAULT_SLIPPAGE_BPS = 100;
const MAX_SLIPPAGE_BPS = 500;
const QUOTE_TTL_MS = 60_000;
const PRICE_IMPACT_HARD_CAP_BPS = 500;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as HexAddress;
const GNOSIS_CHAIN_ID = 100 as const;

type Exact = 'input' | 'output';
type Side = 'buy' | 'sell';

type QuotePayload = {
  version: 1;
  chainId: ChainId;
  side: Side;
  exact: Exact;
  amount: string;
  path: HexAddress[];
  amountIn: string;
  estimatedAmountOut: string;
  minimumAmountOut?: string;
  maximumAmountIn?: string;
  slippageBps: number;
  priceImpactBps?: number;
  quoteCreatedAt: string;
  quoteExpiresAt: string;
};

export type HoneyQuoteInput = {
  side: Side;
  exact: Exact;
  amount: string;
  inputToken?: HexAddress;
  outputToken?: HexAddress;
  path?: HexAddress[];
  slippageBps?: number;
  recipient?: HexAddress;
  chainId?: ChainId;
};

export type HoneyQuoteOutput = {
  quoteId: string;
  side: Side;
  exact: Exact;
  path: HexAddress[];
  amountIn?: string;
  estimatedAmountOut?: string;
  minimumAmountOut?: string;
  maximumAmountIn?: string;
  slippageBps: number;
  priceImpactBps?: number;
  quoteCreatedAt: string;
  quoteExpiresAt: string;
};

export type HoneyApproveTxInput = {
  token: HexAddress;
  spender?: HexAddress;
  amount: string;
  unlimited?: boolean;
  unlimitedApprovalConfirmation?: string;
  from?: HexAddress;
  chainId?: ChainId;
};
export type HoneySwapTxInput = HoneyQuoteInput & { slippageBps: number; recipient: HexAddress; deadlineMinutes?: number; quoteId?: string; from?: HexAddress };

type HoneyDeps = { client?: ChainClient; nowMs?: number };

function optionalAccount(from?: HexAddress): HexAddress | undefined {
  return from ?? (process.env.AGENT_WALLET_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(process.env.AGENT_WALLET_ADDRESS)
    ? process.env.AGENT_WALLET_ADDRESS as HexAddress
    : undefined);
}

function defaultPath(side: Side, inputToken?: HexAddress, outputToken?: HexAddress): HexAddress[] {
  if (inputToken && outputToken) return [inputToken, outputToken];
  return side === 'buy' ? [inputToken ?? TOKENS.WXDAI, outputToken ?? TOKENS.HNY] : [inputToken ?? TOKENS.HNY, outputToken ?? TOKENS.WXDAI];
}

function assertPath(side: Side, path: HexAddress[]): void {
  if (path.length < 2) throw new Error('Swap path must contain at least two token addresses.');
  const hny = TOKENS.HNY.toLowerCase();
  const first = path[0];
  const last = path[path.length - 1];
  if (!first || !last) throw new Error('Swap path must contain at least two token addresses.');
  if (side === 'buy' && last.toLowerCase() !== hny) throw new Error('Buy quotes must output HNY.');
  if (side === 'sell' && first.toLowerCase() !== hny) throw new Error('Sell quotes must input HNY.');
}

async function assertChain(client: ChainClient, chainId: ChainId): Promise<void> {
  const active = await client.getChainId();
  if (active !== chainId) throw new Error(`RPC endpoint is connected to chain ${active}, requested ${chainId}.`);
}

async function tokenDecimals(client: ChainClient, token: HexAddress): Promise<number> {
  return Number(await client.readContract<number>({ address: token, abi: erc20Abi, functionName: 'decimals' }));
}

function applySlippage(amount: bigint, slippageBps: number, direction: 'min' | 'max'): bigint {
  const bps = BigInt(slippageBps);
  return direction === 'min' ? (amount * (10_000n - bps)) / 10_000n : (amount * (10_000n + bps) + 9_999n) / 10_000n;
}

function encodeQuoteId(payload: QuotePayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeHoneyQuoteId(quoteId: string): QuotePayload {
  return JSON.parse(Buffer.from(quoteId, 'base64url').toString('utf8')) as QuotePayload;
}

function pathsEqual(a: HexAddress[], b: HexAddress[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry.toLowerCase() === b[index]?.toLowerCase());
}

async function estimatePriceImpactBps(client: ChainClient, path: HexAddress[], exact: Exact, amountIn: bigint, amountOut: bigint): Promise<number | undefined> {
  if (path.length !== 2 || amountIn === 0n || amountOut === 0n) return undefined;
  const [tokenIn, tokenOut] = path;
  if (!tokenIn || !tokenOut) return undefined;
  const pair = await client.readContract<HexAddress>({ address: HONEYSWAP.FACTORY, abi: honeyswapFactoryAbi, functionName: 'getPair', args: [tokenIn, tokenOut] });
  if (!pair || pair.toLowerCase() === ZERO_ADDRESS.toLowerCase()) return undefined;
  const [reserves, token0] = await Promise.all([
    client.readContract<readonly [bigint, bigint, number]>({ address: pair, abi: honeyswapPairAbi, functionName: 'getReserves' }),
    client.readContract<HexAddress>({ address: pair, abi: honeyswapPairAbi, functionName: 'token0' })
  ]);
  const inputIsToken0 = token0.toLowerCase() === tokenIn.toLowerCase();
  const reserveIn = inputIsToken0 ? reserves[0] : reserves[1];
  const reserveOut = inputIsToken0 ? reserves[1] : reserves[0];
  if (reserveIn === undefined || reserveOut === undefined || reserveIn === 0n || reserveOut === 0n) return undefined;
  if (exact === 'input') {
    const idealOut = (amountIn * reserveOut) / reserveIn;
    if (idealOut <= amountOut || idealOut === 0n) return 0;
    return Number(((idealOut - amountOut) * 10_000n) / idealOut);
  }
  const idealIn = (amountOut * reserveIn + reserveOut - 1n) / reserveOut;
  if (amountIn <= idealIn || amountIn === 0n) return 0;
  return Number(((amountIn - idealIn) * 10_000n) / amountIn);
}

export async function buildHoneyQuote(input: HoneyQuoteInput, deps: HoneyDeps = {}): Promise<OneHiveToolResult<HoneyQuoteOutput>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const slippageBps = input.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
    if (slippageBps > MAX_SLIPPAGE_BPS) return fail('slippage_too_high', `Slippage ${slippageBps} bps exceeds ${MAX_SLIPPAGE_BPS} bps safety cap.`, undefined, false);
    const path = input.path ?? defaultPath(input.side, input.inputToken, input.outputToken);
    assertPath(input.side, path);
    const amountToken = input.exact === 'input' ? path[0] : path[path.length - 1];
    if (!amountToken) return fail('invalid_path', 'Swap path must contain an amount token.', undefined, false);
    const decimals = await tokenDecimals(client, amountToken);
    const amount = parseUnits(input.amount, decimals);
    const amounts = input.exact === 'input'
      ? await client.readContract<bigint[]>({ address: HONEYSWAP.ROUTER, abi: honeyswapRouter02Abi, functionName: 'getAmountsOut', args: [amount, path] })
      : await client.readContract<bigint[]>({ address: HONEYSWAP.ROUTER, abi: honeyswapRouter02Abi, functionName: 'getAmountsIn', args: [amount, path] });
    const amountIn = amounts[0];
    const estimatedAmountOut = amounts[amounts.length - 1];
    if (amountIn === undefined || estimatedAmountOut === undefined) return fail('empty_quote', 'Router returned an empty quote path.', undefined, true);
    const minimumAmountOut = input.exact === 'input' ? applySlippage(estimatedAmountOut, slippageBps, 'min').toString() : undefined;
    const maximumAmountIn = input.exact === 'output' ? applySlippage(amountIn, slippageBps, 'max').toString() : undefined;
    const priceImpactBps = await estimatePriceImpactBps(client, path, input.exact, amountIn, estimatedAmountOut);
    const now = new Date(deps.nowMs ?? Date.now());
    const expires = new Date(now.getTime() + QUOTE_TTL_MS);
    const payload: QuotePayload = {
      version: 1,
      chainId,
      side: input.side,
      exact: input.exact,
      amount: input.amount,
      path,
      amountIn: amountIn.toString(),
      estimatedAmountOut: estimatedAmountOut.toString(),
      ...(minimumAmountOut ? { minimumAmountOut } : {}),
      ...(maximumAmountIn ? { maximumAmountIn } : {}),
      slippageBps,
      ...(priceImpactBps !== undefined ? { priceImpactBps } : {}),
      quoteCreatedAt: now.toISOString(),
      quoteExpiresAt: expires.toISOString()
    };
    const warnings = priceImpactBps !== undefined && priceImpactBps > PRICE_IMPACT_HARD_CAP_BPS
      ? [`Price impact ${priceImpactBps} bps exceeds ${PRICE_IMPACT_HARD_CAP_BPS} bps safety cap; swap preview will be rejected.`]
      : [];
    return ok({
      quoteId: encodeQuoteId(payload),
      side: input.side,
      exact: input.exact,
      path,
      amountIn: amountIn.toString(),
      estimatedAmountOut: estimatedAmountOut.toString(),
      ...(minimumAmountOut ? { minimumAmountOut } : {}),
      ...(maximumAmountIn ? { maximumAmountIn } : {}),
      slippageBps,
      ...(priceImpactBps !== undefined ? { priceImpactBps } : {}),
      quoteCreatedAt: payload.quoteCreatedAt,
      quoteExpiresAt: payload.quoteExpiresAt
    }, warnings);
  } catch (error) {
    return fail('honey_quote_failed', error instanceof Error ? error.message : 'Failed to build Honey quote.', undefined, true);
  }
}

async function simulateAndPolicy(client: ChainClient, preview: TxPreview, abi: readonly unknown[], functionName: string, args: unknown[], account: HexAddress, extra: { quoteCreatedAtMs?: number; nowMs?: number; priceImpactBps?: number; slippageBps?: number; slippageHardCapBps?: number; unlimitedApproval?: boolean; unlimitedApprovalPhraseMatched?: boolean } = {}): Promise<TxPreview> {
  preview.from = account;
  return simulateContractPreviewWithPolicy({
    client,
    preview,
    abi,
    functionName,
    args,
    account,
    policy: { quoteTtlMs: QUOTE_TTL_MS, priceImpactHardCapBps: PRICE_IMPACT_HARD_CAP_BPS, ...extra }
  });
}

export function unlimitedApprovalPhrase(token: HexAddress, spender: HexAddress): string {
  return `APPROVE UNLIMITED ${token} FOR ${spender}`;
}

export async function buildHoneyApprovalPreview(input: HoneyApproveTxInput, deps: HoneyDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const spender = input.spender ?? HONEYSWAP.ROUTER;
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate approval previews.', undefined, false);
    const decimals = await tokenDecimals(client, input.token);
    const amount = input.unlimited ? maxUint256 : parseUnits(input.amount, decimals);
    const phrase = unlimitedApprovalPhrase(input.token, spender);
    const phraseMatched = input.unlimitedApprovalConfirmation === phrase;
    if (input.unlimited && !phraseMatched) return fail('unlimited_approval_rejected', `Unlimited approval requires exact confirmation phrase: ${phrase}`, { confirmationPhrase: phrase }, false);
    const args = [spender, amount] as [HexAddress, bigint];
    const data = encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args });
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: input.token,
      data,
      contractName: 'ERC20',
      method: 'approve',
      args: { spender, amount: amount.toString(), unlimited: input.unlimited ?? false },
      humanSummary: `Approve ${spender} to spend ${input.unlimited ? 'unlimited' : input.amount} of token ${input.token}.`,
      risk: input.unlimited ? 'high' : 'medium'
    });
    const extra = input.unlimited ? { unlimitedApproval: true, unlimitedApprovalPhraseMatched: phraseMatched } : {};
    const simulated = await simulateAndPolicy(client, preview, erc20Abi, 'approve', args, account, extra);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'approve simulation reverted.', simulated, false);
    return ok(simulated);
  } catch (error) {
    return fail('approval_preview_failed', error instanceof Error ? error.message : 'Failed to build approval preview.', undefined, true);
  }
}

function validateQuoteForSwap(input: HoneySwapTxInput, payload: QuotePayload, nowMs: number): OneHiveToolResult<QuotePayload> | undefined {
  const path = input.path ?? defaultPath(input.side, input.inputToken, input.outputToken);
  if (nowMs > Date.parse(payload.quoteExpiresAt)) return fail('stale_quote', 'Honeyswap quote is stale; request a fresh quote.', { quoteExpiresAt: payload.quoteExpiresAt }, false);
  if (input.chainId !== undefined && input.chainId !== payload.chainId) return fail('quote_mismatch', 'Quote ID chain does not match requested swap chain.', { quoteChainId: payload.chainId, requestedChainId: input.chainId }, false);
  if (payload.side !== input.side || payload.exact !== input.exact || payload.amount !== input.amount || !pathsEqual(payload.path, path)) {
    return fail('quote_mismatch', 'Quote ID does not match requested swap parameters.', { quote: payload }, false);
  }
  if (input.slippageBps !== payload.slippageBps) return fail('quote_mismatch', 'Slippage must match the quoted slippage.', { quoteSlippageBps: payload.slippageBps }, false);
  return undefined;
}

type FreshSwapQuote = { amountIn: bigint; estimatedAmountOut: bigint; minimumAmountOut?: bigint; maximumAmountIn?: bigint; priceImpactBps?: number };

async function refreshSwapQuote(client: ChainClient, payload: QuotePayload): Promise<FreshSwapQuote> {
  const amountToken = payload.exact === 'input' ? payload.path[0] : payload.path[payload.path.length - 1];
  if (!amountToken) throw new Error('Quote path is missing an amount token.');
  const decimals = await tokenDecimals(client, amountToken);
  const amount = parseUnits(payload.amount, decimals);
  const amounts = payload.exact === 'input'
    ? await client.readContract<bigint[]>({ address: HONEYSWAP.ROUTER, abi: honeyswapRouter02Abi, functionName: 'getAmountsOut', args: [amount, payload.path] })
    : await client.readContract<bigint[]>({ address: HONEYSWAP.ROUTER, abi: honeyswapRouter02Abi, functionName: 'getAmountsIn', args: [amount, payload.path] });
  const amountIn = amounts[0];
  const estimatedAmountOut = amounts[amounts.length - 1];
  if (amountIn === undefined || estimatedAmountOut === undefined) throw new Error('Router returned an empty quote path.');
  const minimumAmountOut = payload.exact === 'input' ? applySlippage(estimatedAmountOut, payload.slippageBps, 'min') : undefined;
  const maximumAmountIn = payload.exact === 'output' ? applySlippage(amountIn, payload.slippageBps, 'max') : undefined;
  const priceImpactBps = await estimatePriceImpactBps(client, payload.path, payload.exact, amountIn, estimatedAmountOut);
  return {
    amountIn,
    estimatedAmountOut,
    ...(minimumAmountOut !== undefined ? { minimumAmountOut } : {}),
    ...(maximumAmountIn !== undefined ? { maximumAmountIn } : {}),
    ...(priceImpactBps !== undefined ? { priceImpactBps } : {})
  };
}

export async function buildHoneySwapPreview(input: HoneySwapTxInput, deps: HoneyDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    if (!input.quoteId) return fail('quote_required', 'Swap previews require a fresh quoteId from onehive_honey_quote.', undefined, false);
    if (input.slippageBps > MAX_SLIPPAGE_BPS) return fail('slippage_too_high', `Slippage ${input.slippageBps} bps exceeds ${MAX_SLIPPAGE_BPS} bps safety cap.`, undefined, false);
    const payload = decodeHoneyQuoteId(input.quoteId);
    const nowMs = deps.nowMs ?? Date.now();
    const invalidQuote = validateQuoteForSwap(input, payload, nowMs);
    if (invalidQuote) return fail(invalidQuote.error?.code ?? 'quote_invalid', invalidQuote.error?.message ?? 'Quote is invalid.', invalidQuote.error?.details, invalidQuote.error?.retryable ?? false);
    const client = deps.client ?? createChainClientFromEnv(payload.chainId);
    await assertChain(client, payload.chainId);
    const freshQuote = await refreshSwapQuote(client, payload);
    if (freshQuote.priceImpactBps !== undefined && freshQuote.priceImpactBps > PRICE_IMPACT_HARD_CAP_BPS) return fail('price_impact_too_high', `Current price impact ${freshQuote.priceImpactBps} bps exceeds ${PRICE_IMPACT_HARD_CAP_BPS} bps safety cap. Request a fresh quote after reducing trade size.`, { priceImpactBps: freshQuote.priceImpactBps }, false);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate swap previews.', undefined, false);
    const deadline = BigInt(Math.floor(nowMs / 1000) + Math.floor((input.deadlineMinutes ?? 20) * 60));
    const amountIn = freshQuote.amountIn;
    const amountOut = freshQuote.estimatedAmountOut;
    const amountInLimit = freshQuote.maximumAmountIn ?? freshQuote.amountIn;
    const inputToken = payload.path[0];
    if (!inputToken) return fail('invalid_path', 'Quote path is missing an input token.', undefined, false);
    const allowance = await client.readContract<bigint>({ address: inputToken, abi: erc20Abi, functionName: 'allowance', args: [account, HONEYSWAP.ROUTER] });
    const requiredAllowance = input.exact === 'input' ? amountIn : amountInLimit;
    if (allowance < requiredAllowance) return fail('missing_allowance', 'Input token allowance is below the amount required for this swap.', { allowance: allowance.toString(), requiredAllowance: requiredAllowance.toString(), token: inputToken }, false);
    const functionName = input.exact === 'input' ? 'swapExactTokensForTokens' : 'swapTokensForExactTokens';
    const args = input.exact === 'input'
      ? [amountIn, freshQuote.minimumAmountOut ?? freshQuote.estimatedAmountOut, payload.path, input.recipient, deadline]
      : [amountOut, amountInLimit, payload.path, input.recipient, deadline];
    const data = encodeFunctionData({ abi: honeyswapRouter02Abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
    const preview = buildTxPreview({
      chainId: payload.chainId,
      from: account,
      to: HONEYSWAP.ROUTER,
      data,
      contractName: 'HoneyswapRouter02',
      method: functionName,
      args: { side: input.side, exact: input.exact, amountIn: amountIn.toString(), estimatedAmountOut: amountOut.toString(), recipient: input.recipient, deadline: deadline.toString(), path: payload.path },
      humanSummary: `${input.side === 'buy' ? 'Buy' : 'Sell'} HNY through Honeyswap with ${input.slippageBps} bps slippage for recipient ${input.recipient}.`,
      risk: 'high'
    });
    const policyExtra: { quoteCreatedAtMs: number; nowMs: number; priceImpactBps?: number; slippageBps: number; slippageHardCapBps: number } = { quoteCreatedAtMs: Date.parse(payload.quoteCreatedAt), nowMs, slippageBps: input.slippageBps, slippageHardCapBps: MAX_SLIPPAGE_BPS };
    if (freshQuote.priceImpactBps !== undefined) policyExtra.priceImpactBps = freshQuote.priceImpactBps;
    const simulated = await simulateAndPolicy(client, preview, honeyswapRouter02Abi, functionName, args, account, policyExtra);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', `${functionName} simulation reverted.`, simulated, false);
    return ok(simulated);
  } catch (error) {
    return fail('swap_preview_failed', error instanceof Error ? error.message : 'Failed to build swap preview.', undefined, true);
  }
}

export const honeyQuoteTool: ToolDefinition<HoneyQuoteInput, HoneyQuoteOutput> = {
  name: 'onehive_honey_quote',
  description: 'Quote buying or selling HNY on Honeyswap Router02.',
  inputSchema: {
    type: 'object', required: ['side', 'exact', 'amount'], additionalProperties: false,
    properties: { side: { enum: ['buy', 'sell'] }, exact: { enum: ['input', 'output'] }, amount: { type: 'string', pattern: uintStringPattern }, inputToken: { type: 'string', pattern: addressPattern }, outputToken: { type: 'string', pattern: addressPattern }, path: { type: 'array', items: { type: 'string', pattern: addressPattern }, minItems: 2 }, slippageBps: { type: 'number', minimum: 1, maximum: 5000 }, recipient: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } }
  },
  handler: (input) => buildHoneyQuote(input)
};

export const honeyApproveTxTool: ToolDefinition<HoneyApproveTxInput, TxPreview> = {
  name: 'onehive_honey_approveTx',
  description: 'Build an unsigned ERC-20 approval transaction preview for Honeyswap.',
  inputSchema: {
    type: 'object', required: ['token', 'amount'], additionalProperties: false,
    properties: { token: { type: 'string', pattern: addressPattern }, spender: { type: 'string', pattern: addressPattern }, amount: { type: 'string', pattern: uintStringPattern }, unlimited: { type: 'boolean' }, unlimitedApprovalConfirmation: { type: 'string' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } }
  },
  handler: (input) => buildHoneyApprovalPreview(input)
};

export const honeySwapTxTool: ToolDefinition<HoneySwapTxInput, TxPreview> = {
  name: 'onehive_honey_swapTx',
  description: 'Build an unsigned Honeyswap Router02 swap transaction preview for HNY buy/sell.',
  inputSchema: {
    type: 'object', required: ['side', 'exact', 'amount', 'slippageBps', 'recipient', 'quoteId'], additionalProperties: false,
    properties: { side: { enum: ['buy', 'sell'] }, exact: { enum: ['input', 'output'] }, amount: { type: 'string', pattern: uintStringPattern }, inputToken: { type: 'string', pattern: addressPattern }, outputToken: { type: 'string', pattern: addressPattern }, path: { type: 'array', items: { type: 'string', pattern: addressPattern }, minItems: 2 }, slippageBps: { type: 'number', minimum: 1, maximum: 5000 }, recipient: { type: 'string', pattern: addressPattern }, deadlineMinutes: { type: 'number', minimum: 1, maximum: 120 }, quoteId: { type: 'string' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } }
  },
  handler: (input) => buildHoneySwapPreview(input)
};
