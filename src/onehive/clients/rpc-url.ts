import { CHAINS } from '../addresses.js';
import type { ChainId } from '../schemas.js';

export function rpcUrlFromEnv(chainId: ChainId): string {
  if (chainId === 100) {
    return process.env[CHAINS.gnosis.rpcEnv] ?? 'https://rpc.gnosischain.com';
  }
  if (chainId === 10200) return process.env[CHAINS.chiado.rpcEnv] ?? 'https://rpc.chiadochain.net';
  return process.env[CHAINS.localFork.rpcEnv] ?? 'http://127.0.0.1:8545';
}
