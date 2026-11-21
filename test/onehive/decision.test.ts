import { describe, expect, it } from 'vitest';
import { ONEHIVE } from '../../src/onehive/addresses.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import { buildDecisionCastVotePreview, buildDecisionExecutePreview, buildDecisionNewVotePreview, readDecisionVote } from '../../src/onehive/tools/decision.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;
const zero = '0x0000000000000000000000000000000000000000' as HexAddress;
const executionScript = '0x00000001' as HexData;

function fakeClient(options: { chainId?: 100 | 31337; activeChainId?: number; canVote?: boolean; canExecute?: boolean; open?: boolean; simulationStatus?: 'success' | 'revert'; executionScriptHash?: HexData } = {}): ChainClient {
  const chainId = options.chainId ?? 100;
  const scriptHash = options.executionScriptHash ?? '0x1d787fe3537d0be065eb1de6f5e25c42bf7f410e72ddbac52b91381a8679f5c8' as HexData;
  return {
    chainId,
    rpcUrl: 'mock://gnosis',
    async getChainId() { return options.activeChainId ?? chainId; },
    async getBytecode() { return '0x60016000' as HexData; },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      if (request.functionName === 'getVote') return [10n, 2n, 100n, 1000n, 99n, 0, 0n, 42n, 0n, 0n, 0n, 0, scriptHash] as T;
      if (request.functionName === 'getSetting') return [1209600n, 500000000000000000n, 100000000000000000n, 604800n, 86400n, 43200n, 172800n] as T;
      if (request.functionName === 'canExecute') return Boolean(options.canExecute) as T;
      if (request.functionName === 'isVoteOpenForVoting') return (options.open ?? true) as T;
      if (request.functionName === 'canVote') return (options.canVote ?? true) as T;
      if (request.functionName === 'getCastVote') return [0, zero] as T;
      throw new Error(`Unexpected read: ${request.functionName}`);
    },
    async simulateContract(_request: ContractSimulationRequest) {
      return options.simulationStatus === 'revert'
        ? { status: 'revert' as const, revertReason: 'execution reverted: nope' }
        : { status: 'success' as const, gasEstimate: 12345n };
    },
    async estimateGas(_tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>) { return 12345n; }
  };
}

describe('Decision / Disputable Voting tools', () => {
  it('reads Decision vote state and voter state', async () => {
    const result = await readDecisionVote({ chainId: 100, voteId: '1', voter: from }, { client: fakeClient() });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ voteId: '1', status: 'Normal', actionId: '42', canExecute: false, isOpenForVoting: true });
    expect(result.data?.setting).toMatchObject({ voteTime: '1209600', executionDelay: '172800' });
    expect(result.data?.voter).toMatchObject({ address: from, canVote: true, state: 'Absent' });
  });

  it('builds a simulated newVote preview', async () => {
    const result = await buildDecisionNewVotePreview({ chainId: 100, from, context: 'ipfs://decision-test', executionScript }, { client: fakeClient() });

    expect(result.ok).toBe(true);
    expect(result.data?.to).toBe(ONEHIVE.DISPUTABLE_VOTING);
    expect(result.data?.decoded).toMatchObject({ contractName: 'DisputableVoting', method: 'newVote' });
    expect(result.data?.simulation).toEqual({ status: 'success', gasEstimate: '12345' });
    expect(result.data?.policy.checks.some((check) => check.name === 'abi-lock' && check.status === 'pass')).toBe(true);
  });

  it('requires a sender for newVote previews', async () => {
    const result = await buildDecisionNewVotePreview({ chainId: 100, context: 'ipfs://decision-test' }, { client: fakeClient() });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('from_required');
  });

  it('builds a simulated vote preview', async () => {
    const result = await buildDecisionCastVotePreview({ chainId: 100, from, voteId: 1, supports: true }, { client: fakeClient() });

    expect(result.ok).toBe(true);
    expect(result.data?.decoded).toMatchObject({ method: 'vote', args: { voteId: '1', supports: true } });
  });

  it('refuses vote previews when the vote is closed', async () => {
    const result = await buildDecisionCastVotePreview({ chainId: 100, from, voteId: 1, supports: true }, { client: fakeClient({ open: false }) });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('vote_not_open');
  });

  it('refuses execute previews when the vote is not executable', async () => {
    const result = await buildDecisionExecutePreview({ chainId: 100, from, voteId: 1, executionScript }, { client: fakeClient({ canExecute: false }) });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cannot_execute');
  });

  it('rejects execution script mismatches before simulation', async () => {
    const result = await buildDecisionExecutePreview({ chainId: 100, from, voteId: 1, executionScript: '0x1234' }, { client: fakeClient({ canExecute: true }) });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('execution_script_mismatch');
  });

  it('returns structured failures on simulation reverts', async () => {
    const result = await buildDecisionCastVotePreview({ chainId: 100, from, voteId: 1, supports: true }, { client: fakeClient({ simulationStatus: 'revert' }) });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('simulation_reverted');
  });
});
