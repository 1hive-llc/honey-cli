import { custom } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { createViemChainClient, hasCode, rpcUrlFromEnv } from '../../src/onehive/clients/chain.js';
import type { HexAddress } from '../../src/onehive/schemas.js';

describe('viem chain client', () => {
  it('uses default RPC URLs from chain context', () => {
    for (const name of ['GNOSIS_RPC_URL', 'CHIADO_RPC_URL', 'FORK_RPC_URL']) {
      vi.stubEnv(name, undefined);
    }
    try {
      expect(rpcUrlFromEnv(100)).toBe('https://rpc.gnosischain.com');
      expect(rpcUrlFromEnv(10200)).toBe('https://rpc.chiadochain.net');
      expect(rpcUrlFromEnv(31337)).toBe('http://127.0.0.1:8545');
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('reads active chain ID and bytecode through viem transport', async () => {
    const calls: string[] = [];
    const client = createViemChainClient({
      chainId: 100,
      rpcUrl: 'mock://gnosis',
      transport: custom({
        async request({ method }) {
          calls.push(method);
          if (method === 'eth_chainId') return '0x64';
          if (method === 'eth_getCode') return '0x60016000';
          throw new Error(`Unexpected RPC method ${method}`);
        }
      })
    });

    await expect(client.getChainId()).resolves.toBe(100);
    await expect(client.getBytecode('0x71850b7E9Ee3f13Ab46d67167341E4bDc905Eef9' as HexAddress)).resolves.toBe('0x60016000');
    expect(calls).toEqual(['eth_chainId', 'eth_getCode']);
  });

  it('detects missing bytecode', async () => {
    const client = createViemChainClient({
      chainId: 100,
      rpcUrl: 'mock://gnosis',
      transport: custom({
        async request({ method }) {
          if (method === 'eth_getCode') return '0x';
          if (method === 'eth_chainId') return '0x64';
          throw new Error(`Unexpected RPC method ${method}`);
        }
      })
    });

    await expect(hasCode(client, '0x71850b7E9Ee3f13Ab46d67167341E4bDc905Eef9' as HexAddress)).resolves.toBe(false);
  });
});
