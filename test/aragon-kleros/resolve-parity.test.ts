import { decodeFunctionResult, encodeFunctionData, type Abi } from 'viem';
import { afterEach, expect, it, vi } from 'vitest';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import type { ChainClient, ContractReadRequest } from '../../src/onehive/clients/chain.js';
import { preflightSubmitPreview } from '../../src/onehive/tools/tx-preflight.js';
import { adapter, agreement, agreementId, caseFixture, caseRequest, operator } from '../kleros-court/fixture.js';
import { previewAgreementResolve } from './resolve-reference.js';

afterEach(() => vi.unstubAllEnvs());

it.each([2n, 3n, 4n])('agrees on exact resolve calldata for final Agreement ruling %s across the two input contracts', async ruling => {
  vi.stubEnv('ONEHIVE_AGREEMENT', agreement);
  const recording = caseFixture({ id: 0n, period: 4, finalised: true, ruling });
  for (const method of ['canChallenge', 'canClose', 'canSettle', 'canClaimSettlement', 'canDispute']) {
    recording.set(agreement, agreementAbi, method, [11n], false);
  }
  const client: ChainClient = {
    chainId: 31337, rpcUrl: 'mock://resolve', getChainId: async () => 31337, getBytecode: async () => '0x6000',
    estimateGas: async () => 31000n, simulateContract: async () => ({ status: 'success', gasEstimate: 31000n }),
    async readContract<T>({ abi, address, functionName, args }: ContractReadRequest) {
      const binding = { abi: abi as Abi, functionName };
      const data = encodeFunctionData({ ...binding, args: args ?? [] });
      const call = recording.calls.get(address + data);
      if (!call) throw new Error('Unknown synthetic getter');
      return decodeFunctionResult({ ...binding, data: call.result }) as T;
    }
  };
  const recorded = recording.run('resolve', { ...caseRequest, from: operator }).data;
  if (!recorded || !('preview' in recorded) || !recorded.preview) throw new Error('Missing recorded resolve preview');
  const tx = recorded.preview;
  const reference = await previewAgreementResolve({ chainId: 31337, actionId: '11', from: operator, expectedAdapter: adapter }, client);
  expect(reference.data).toMatchObject({ chainId: tx.chainId, to: tx.to, from: tx.from, value: tx.value, data: tx.data,
    decoded: { method: 'resolve', args: { disputeId: agreementId(0n).toString() } }, simulation: { status: 'success' } });
  expect(recorded).toMatchObject({ ids: { actionId: '11', challengeId: '18', coreDisputeId: '0' },
    savedSetting: { id: '5', arbitrator: adapter }, adapterRuling: String(ruling), coreRuling: String(ruling - 2n) });
  expect(tx.simulation.status).toBe('not-run');
  const preflight = await preflightSubmitPreview({ tx, client });
  for (const name of ['abi-lock', 'decoded-method']) expect(preflight.checks).toContainEqual(expect.objectContaining({ name, status: 'fail' }));
});
