import { describe, expect, it } from 'vitest';
import { resolveOneHiveContext } from '../../src/onehive/tools/context.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';

function fakeClient(chainId: 100 | 10200 | 31337 = 100, options: { activeChainId?: number; bytecode?: HexData | undefined } = {}): ChainClient {
  return {
    chainId,
    rpcUrl: 'http://localhost:8545',
    async getChainId() {
      return options.activeChainId ?? chainId;
    },
    async getBytecode() {
      return options.bytecode === undefined ? '0x60016000' as HexData : options.bytecode;
    },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      if (request.functionName === 'symbol') {
        return (request.address.endsWith('Eef9') ? 'HNY' : 'WXDAI') as T;
      }
      if (request.functionName === 'decimals') return 18 as T;
      if (request.functionName === 'balanceOf') return 123n as T;
      throw new Error(`Unexpected read: ${request.functionName}`);
    },
    async simulateContract(_request: ContractSimulationRequest) {
      return { status: 'success' as const, gasEstimate: 21_000n };
    },
    async estimateGas(_tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>) {
      return 21_000n;
    }
  };
}

describe('onehive context resolver', () => {
  it('resolves Gnosis context, token metadata, balances, and bytecode verification with an injected client', async () => {
    const previousKernel = process.env.ONEHIVE_DAO_KERNEL;
    const envKernel = '0x1111111111111111111111111111111111111111' as HexAddress;
    process.env.ONEHIVE_DAO_KERNEL = envKernel;

    try {
      const result = await resolveOneHiveContext(
        { chainId: 100, verifyCode: true, includeBalancesFor: '0x2222222222222222222222222222222222222222' },
        fakeClient(100)
      );

      expect(result.chain).toMatchObject({ id: 100, name: 'Gnosis Chain', rpcUrl: 'http://localhost:8545' });
      expect(result.contracts.ONEHIVE_DAO_KERNEL).toBe(envKernel);
      expect(result.tokens.HNY).toMatchObject({ symbol: 'HNY', decimals: 18, balance: '123' });
      expect(result.tokens.WXDAI).toMatchObject({ symbol: 'WXDAI', decimals: 18, balance: '123' });
      expect(result.featureFlags).toMatchObject({ disputableVotingWritesEnabled: true, mainnetSubmissionEnabled: false });
      expect(result.verification.length).toBeGreaterThan(2);
      expect(result.verification.every((entry) => entry.hasCode === true && entry.bytecodeHash?.startsWith('0x'))).toBe(true);
      expect(result.warnings).toEqual(expect.arrayContaining([
        'Decision/Disputable Voting writes are enabled only as unsigned simulated previews with confirmation-gated unsigned Safe handoff.'
      ]));
    } finally {
      if (previousKernel === undefined) delete process.env.ONEHIVE_DAO_KERNEL;
      else process.env.ONEHIVE_DAO_KERNEL = previousKernel;
    }
  });

  it('warns for Chiado/test mode and omits bytecode fields when verification is not requested', async () => {
    const result = await resolveOneHiveContext({ chainId: 10200, verifyCode: false }, fakeClient(10200));

    expect(result.chain.id).toBe(10200);
    expect(result.verification[0]).not.toHaveProperty('hasCode');
    expect(result.warnings.some((warning) => warning.includes('Chiado/test mode selected'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('Bytecode verification was not requested'))).toBe(true);
  });


  it('warns for local fork mode and uses Gnosis addresses', async () => {
    const result = await resolveOneHiveContext({ chainId: 31337, verifyCode: false }, fakeClient(31337));

    expect(result.chain).toMatchObject({ id: 31337, name: 'Local Gnosis Fork' });
    expect(result.contracts.ONEHIVE_CONVICTION_VOTING).toBe('0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2');
    expect(result.warnings.some((warning) => warning.includes('Local fork mode selected'))).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('Subgraphs will not reflect fork-local transactions'))).toBe(true);
  });

  it('throws a wrong-chain error when the active RPC chain mismatches the request', async () => {
    await expect(resolveOneHiveContext({ chainId: 100 }, fakeClient(100, { activeChainId: 10200 }))).rejects.toThrow('requested chain 100');
  });

  it('warns when bytecode verification finds an address without code', async () => {
    const result = await resolveOneHiveContext({ chainId: 100, verifyCode: true }, fakeClient(100, { bytecode: '0x' }));

    expect(result.verification.some((entry) => entry.hasCode === false)).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('found no code'))).toBe(true);
  });
});
