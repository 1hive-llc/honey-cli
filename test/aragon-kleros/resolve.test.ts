import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, maxUint256, parseAbi } from 'viem';
import { previewAgreementResolve } from './resolve-reference.js';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import { preflightSubmitPreview } from '../../src/onehive/tools/tx-preflight.js';

const input = { chainId: 31337, actionId: '12', from: '0x1111111111111111111111111111111111111111',
  expectedAdapter: '0x2222222222222222222222222222222222222222' };
// keccak256 of two ABI words: adapter address and Core dispute zero.
const disputeId = 38933219463763923841179619431086220637720010430953097992554337445184451921276n;

function fixture(options: { state?: number; actionRef?: bigint; active?: boolean; closed?: boolean; reverts?: boolean;
  arbitrator?: string; settingUnreadable?: boolean; boundAgreement?: string; coreId?: bigint; exists?: boolean;
  finalised?: boolean; ruling?: bigint; bindingUnreadable?: boolean } = {}) {
  const adapterReads: string[] = [];
  const simulateContract = vi.fn(async (_request: ContractSimulationRequest) => options.reverts
    ? { status: 'revert' as const, revertReason: 'NotFinal' }
    : { status: 'success' as const, gasEstimate: 31000n });
  const client: ChainClient = {
    chainId: 31337, rpcUrl: 'mock://fixture', getChainId: async () => 31337,
    getBytecode: async () => '0x6000', estimateGas: async () => 31000n, simulateContract,
    async readContract<T>({ address, functionName, args }: ContractReadRequest) {
      if (address === input.expectedAdapter) {
        adapterReads.push(functionName);
        if (options.bindingUnreadable) throw new Error('unavailable');
        if (functionName === 'agreement') return (options.boundAgreement ?? ONEHIVE.AGREEMENT) as T;
        expect(functionName).toBe('disputes');
        expect(args).toEqual([disputeId]);
        return [options.coreId ?? 0n, options.ruling ?? 4n, options.exists ?? true, options.finalised ?? true] as T;
      }
      expect(address).toBe(ONEHIVE.AGREEMENT);
      if (functionName === 'getSetting') {
        expect(args).toEqual([4n]);
        if (options.settingUnreadable) throw new Error('unavailable');
        return [options.arbitrator ?? input.expectedAdapter, input.from, '', '0x'] as T;
      }
      const values: Record<string, unknown> = {
        getAction: [ONEHIVE.DISPUTABLE_VOTING, 48n, 1n, 4n, input.from, options.closed ?? false, '0x', 83n, options.active ?? true],
        getChallenge: [options.actionRef ?? 12n, input.from, 999n, '0x', 0n, options.state ?? 2, true, true, disputeId, 0n],
        getCollateralRequirement: [TOKENS.HNY, 86400n, 100n, 200n],
        getChallengeArbitratorFees: [TOKENS.HNY, 9n, TOKENS.HNY, 9n],
        canChallenge: false, canClose: false, canSettle: false, canClaimSettlement: false, canDispute: false
      };
      expect(functionName in values).toBe(true);
      if (functionName === 'getAction') expect(args).toEqual([12n]);
      if (functionName === 'getChallenge') expect(args).toEqual([83n]);
      return values[functionName] as T;
    }
  };
  return { client, simulateContract, adapterReads };
}

describe('Agreement resolve preview', () => {
  beforeEach(() => { vi.stubEnv('ONEHIVE_AGREEMENT', ONEHIVE.AGREEMENT); });
  afterEach(() => { vi.unstubAllEnvs(); });

  it('simulates the Agreement call with the full dispute ID and retains the failed native submit gate', async () => {
    const { client, simulateContract } = fixture();
    const result = await previewAgreementResolve(input, client);
    expect(result.ok).toBe(true);
    const tx = result.data!;
    expect(tx).toMatchObject({
      from: input.from, to: ONEHIVE.AGREEMENT, value: '0',
      decoded: { method: 'resolve', args: { disputeId: disputeId.toString() } },
      simulation: { status: 'success', gasEstimate: '31000' }, policy: { risk: 'critical' }
    });
    expect(tx.data).toBe(encodeFunctionData({ abi: parseAbi(['function resolve(uint256)']), functionName: 'resolve', args: [disputeId] }));
    expect(simulateContract).toHaveBeenCalledWith(expect.objectContaining({
      address: ONEHIVE.AGREEMENT, functionName: 'resolve', account: input.from, args: [disputeId]
    }));
    expect(result.warningDetails).toContainEqual(expect.objectContaining({ severity: 'critical' }));
    expect(tx.policy.checks).toContainEqual(expect.objectContaining({ name: 'abi-lock', status: 'fail' }));
    const preflight = await preflightSubmitPreview({ tx, client });
    expect(preflight.selector.abiLockStatus).toBe('missing');
    expect(preflight.checks).toContainEqual(expect.objectContaining({ name: 'decoded-method', status: 'fail' }));
  });

  it.each([{ state: 0 }, { state: 1 }, { state: 3 }, { state: 4 }, { state: 5 }, { active: false }, { closed: true }, { actionRef: 77n }])(
    'declines ineligible or unrelated challenge %o', async options => {
      const { client, simulateContract } = fixture(options);
      expect((await previewAgreementResolve(input, client)).error?.code).toBe('no_active_dispute');
      expect(simulateContract).not.toHaveBeenCalled();
    }
  );

  it.each([{ arbitrator: '0x3333333333333333333333333333333333333333' }, { settingUnreadable: true }])(
    'stops at read-only designation for an unrecognised action setting %o', async options => {
      const { client, simulateContract, adapterReads } = fixture(options);
      expect((await previewAgreementResolve(input, client)).error?.code).toBe('unknown_court');
      expect(adapterReads).toEqual([]);
      expect(simulateContract).not.toHaveBeenCalled();
    }
  );

  it.each([{ boundAgreement: input.from }, { coreId: 1n }, { exists: false }, { bindingUnreadable: true }])(
    'rejects an unverified adapter or dispute binding %o', async options => {
      const { client, simulateContract } = fixture(options);
      expect((await previewAgreementResolve(input, client)).error?.code).toBe('unknown_court');
      expect(simulateContract).not.toHaveBeenCalled();
    }
  );

  it.each([{ finalised: false }, { ruling: 5n }])('requires a final mapped Kleros ruling %o', async options => {
    const { client, simulateContract } = fixture(options);
    expect((await previewAgreementResolve(input, client)).error?.code).toBe('no_final_ruling');
    expect(simulateContract).not.toHaveBeenCalled();
  });

  it('reports failed Agreement simulation even after final Kleros ruling delivery', async () => {
    const { client } = fixture({ reverts: true });
    expect((await previewAgreementResolve(input, client)).error?.code).toBe('simulation_reverted');
  });

  it('rejects a wrong chain, absent bytecode and invalid identifiers', async () => {
    const { client } = fixture();
    expect((await previewAgreementResolve({ ...input, chainId: 100 }, client)).error?.code).toBe('agreement_read_failed');
    for (const actionId of ['-1', '1e3', (maxUint256 + 1n).toString()]) {
      expect((await previewAgreementResolve({ ...input, actionId }, client)).error?.code).toBe('invalid_input');
    }
    client.getBytecode = async () => '0x';
    expect((await previewAgreementResolve(input, client)).error?.code).toBe('no_agreement_code');
  });
});
