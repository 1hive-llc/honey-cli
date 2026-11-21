import { describe, expect, it } from 'vitest';
import {
  buildAddProposalPreview,
  buildProposalActionPreview,
  buildProposalTokenPreview,
  readConvictionProposal
} from '../../src/onehive/tools/governance.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;
const beneficiary = '0x2222222222222222222222222222222222222222' as HexAddress;

type FakeOptions = {
  activeChainId?: number;
  open?: boolean;
  executed?: boolean;
  bytecode?: HexData | undefined;
  simulation?: { status: 'success'; gasEstimate?: bigint } | { status: 'revert'; revertReason?: string };
};

function fakeClient(options: FakeOptions = {}): ChainClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chainId: 100,
    rpcUrl: 'mock://gnosis',
    async getChainId() {
      calls.push('getChainId');
      return options.activeChainId ?? 100;
    },
    async getBytecode() {
      calls.push('getBytecode');
      return options.bytecode === undefined ? '0x60016000' as HexData : options.bytecode;
    },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      calls.push(`read:${request.functionName}`);
      if (request.functionName === 'getProposal') {
        const status = options.executed ? 3 : options.open === false ? 2 : 0;
        return [100n, false, beneficiary, 50n, 25n, 123n, 0n, status, from, 200n] as T;
      }
      throw new Error(`Unexpected read ${request.functionName}`);
    },
    async simulateContract(request: ContractSimulationRequest) {
      calls.push(`simulate:${request.functionName}`);
      return options.simulation ?? { status: 'success' as const, gasEstimate: 123456n };
    },
    async estimateGas(_tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>) {
      calls.push('estimateGas');
      return 123456n;
    }
  };
}

describe('Conviction Voting governance helpers', () => {
  it('reads proposal state', async () => {
    const client = fakeClient({ open: false, executed: true });
    const proposal = await readConvictionProposal({ proposalId: '212' }, client);

    expect(proposal).toMatchObject({ proposalId: '212', open: false, executed: true, status: 'Executed', statusCode: 3, requestedAmount: '100', beneficiary });
    expect(client.calls).toEqual(['getChainId', 'read:getProposal']);
  });

  it('builds and simulates addProposal calldata preview', async () => {
    const client = fakeClient();
    const result = await buildAddProposalPreview({
      title: 'Test proposal',
      link: 'https://forum.example/proposal',
      requestedAmountHnyOrWxDai: '1.5',
      stableRequestAmount: false,
      beneficiary,
      from
    }, { client });

    expect(result.ok).toBe(true);
    expect(result.data?.data).toMatch(/^0x[0-9a-f]+/i);
    expect(result.data?.decoded.method).toBe('addProposal');
    expect(result.data?.simulation).toMatchObject({ status: 'success', gasEstimate: '123456' });
    expect(result.data?.policy.checks.some((check) => check.name === 'simulation' && check.status === 'pass')).toBe(true);
  });

  it('rejects previews without a sender for simulation', async () => {
    const previous = process.env.AGENT_WALLET_ADDRESS;
    delete process.env.AGENT_WALLET_ADDRESS;
    try {
      const result = await buildAddProposalPreview({
        title: 'Test proposal',
        link: 'https://forum.example/proposal',
        requestedAmountHnyOrWxDai: '1',
        stableRequestAmount: false,
        beneficiary
      }, { client: fakeClient() });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('from_required');
      expect(result.error?.message).toContain('from address');
    } finally {
      if (previous === undefined) delete process.env.AGENT_WALLET_ADDRESS;
      else process.env.AGENT_WALLET_ADDRESS = previous;
    }
  });

  it('builds stake and withdraw amount previews', async () => {
    const stake = await buildProposalTokenPreview({ proposalId: 1, amountHny: '2', from }, 'stake', { client: fakeClient() });
    const withdraw = await buildProposalTokenPreview({ proposalId: 1, amountHny: '0.5', from }, 'withdraw', { client: fakeClient() });

    expect(stake.ok).toBe(true);
    expect(stake.data?.decoded.method).toBe('stakeToProposal');
    expect(withdraw.ok).toBe(true);
    expect(withdraw.data?.decoded.method).toBe('withdrawFromProposal');
  });

  it('rejects ambiguous all plus amount inputs', async () => {
    const result = await buildProposalTokenPreview({ proposalId: 1, all: true, amountHny: '1', from }, 'stake', { client: fakeClient() });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('ambiguous_amount');
  });

  it('refuses execute preview for already executed proposals without simulating', async () => {
    const client = fakeClient({ executed: true });
    const result = await buildProposalActionPreview({ proposalId: 1, from }, 'execute', { client });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('proposal_executed');
    expect(client.calls).not.toContain('simulate:executeProposal');
  });

  it('returns a structured failure when simulation reverts', async () => {
    const result = await buildProposalActionPreview({ proposalId: 1, from }, 'cancel', {
      client: fakeClient({ simulation: { status: 'revert', revertReason: 'not authorized' } })
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('simulation_reverted');
    expect(result.error?.details).toMatchObject({ simulation: { status: 'revert', revertReason: 'not authorized' } });
  });
});
