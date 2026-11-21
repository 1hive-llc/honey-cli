import { parseUnits } from 'viem';
import { TOKENS } from './addresses.js';
import type { HexAddress } from './schemas.js';

export const KNOWN_TOKEN_DECIMALS = {
  [TOKENS.HNY.toLowerCase()]: 18,
  [TOKENS.WXDAI.toLowerCase()]: 18
} as const;

export function knownTokenDecimals(token: HexAddress): number {
  return KNOWN_TOKEN_DECIMALS[token.toLowerCase() as keyof typeof KNOWN_TOKEN_DECIMALS] ?? 18;
}

export function parseKnownTokenAmount(amount: string, token: HexAddress): bigint {
  return parseUnits(amount, knownTokenDecimals(token));
}

export function parseHnyAmount(amount: string): bigint {
  return parseKnownTokenAmount(amount, TOKENS.HNY);
}

export function parseWxDaiAmount(amount: string): bigint {
  return parseKnownTokenAmount(amount, TOKENS.WXDAI);
}
