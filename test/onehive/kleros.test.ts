import { decodeFunctionData, parseAbi } from 'viem';
import { describe, expect, it, vi } from 'vitest';
import { buildDispatch } from '../../src/honey-cli.js';
import { getOneHiveTool } from '../../src/onehive/tool-registry.js';
import { readKlerosStatus, readKlerosAdapterStatus, buildKlerosStakeTx } from '../../src/onehive/tools/kleros.js';
import type { ChainClient } from '../../src/onehive/clients/chain.js';
import type { HexAddress } from '../../src/onehive/schemas.js';

const core = '0x1111111111111111111111111111111111111111' as HexAddress;
const token = '0x2222222222222222222222222222222222222222' as HexAddress;
const sortition = '0x3333333333333333333333333333333333333333' as HexAddress;
const strategy = '0x4444444444444444444444444444444444444444' as HexAddress;
const input = { chainId: 31337 as const, core, expectedToken: token };
function client(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = { pinakion: token, sortitionModule: sortition, paused: false,
    arbitrationPaused: true, acceptedFeeTokens: true, core, stakeWeightStrategy: strategy, totalStaked: 100000000000000000001n, ...overrides };
  return {
    chainId: 31337, rpcUrl: 'http://localhost:8545', getChainId: vi.fn(async () => 31337),
    getBytecode: vi.fn(async () => '0x6000'),
    readContract: vi.fn(async ({ functionName }: { functionName: string }) => values[functionName]),
    sendTransaction: vi.fn(), simulateContract: vi.fn(), estimateGas: vi.fn()
  } as unknown as ChainClient;
}

describe('Kleros inspection', () => {
  it('dispatches explicit bindings and returns raw amounts without signing', async () => {
    expect(buildDispatch(['kleros', 'status', '--chain', '31337', '--core', core, '--expected-token', token]))
      .toEqual({ toolName: 'onehive_kleros_status', input });
    expect(getOneHiveTool('onehive_kleros_status')).toBeDefined();
    const rpc = client();
    expect(await readKlerosStatus(input, rpc)).toMatchObject({ core, stakingToken: token, sortitionModule: sortition,
      totalStakedRaw: '100000000000000000001', honeyArbitrationFeesAccepted: true, arbitrationPaused: true });
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
    expect(rpc.simulateContract).not.toHaveBeenCalled();
  });
  it('reports disabled Honey fees and queries the explicit staking token', async () => {
    const rpc = client({ acceptedFeeTokens: false });
    expect(await readKlerosStatus(input, rpc)).toMatchObject({ honeyArbitrationFeesAccepted: false });
    expect(rpc.readContract).toHaveBeenCalledWith(expect.objectContaining({ functionName: 'acceptedFeeTokens', args: [token] }));
  });
  it('rejects wrong chains before contract reads', async () => {
    const rpc = client(); vi.mocked(rpc.getChainId).mockResolvedValue(100);
    await expect(readKlerosStatus(input, rpc)).rejects.toThrow('does not match');
    expect(rpc.readContract).not.toHaveBeenCalled();
  });
  it('rejects a different token, wrong core link and absent Honey strategy', async () => {
    await expect(readKlerosStatus(input, client({ pinakion: core }))).rejects.toThrow('staking token');
    await expect(readKlerosStatus(input, client({ core: token }))).rejects.toThrow('different core');
    await expect(readKlerosStatus(input, client({ stakeWeightStrategy: '0x0000000000000000000000000000000000000000' }))).rejects.toThrow('nonzero');
  });
  it('rejects missing code and missing explicit chain', async () => {
    const rpc = client(); vi.mocked(rpc.getBytecode).mockResolvedValue('0x');
    await expect(readKlerosStatus(input, rpc)).rejects.toThrow('no deployed bytecode');
    await expect(readKlerosStatus({ ...input, chainId: undefined } as never, client())).rejects.toThrow('explicit');
  });
});


describe('Agreement adapter inspection', () => {
  const adapter = '0x5555555555555555555555555555555555555555' as HexAddress;
  const agreement = '0x6666666666666666666666666666666666666666' as HexAddress;
  const id = (2n ** 255n + 7n).toString();
  const binding = { ...input, adapter, agreement, disputeId: id };
  function rpc(finalised = false) {
    return client({ honey: token, agreement, getDisputeFees: [adapter, token, 100n], disputes: [7n, finalised ? 4n : 0n, true, finalised] });
  }
  it('keeps namespaced IDs lossless and finality separate from execution', async () => {
    expect(buildDispatch(['kleros', 'adapter-status', '--chain', '31337', '--core', core, '--expected-token', token,
      '--adapter', adapter, '--agreement', agreement, '--dispute', id])).toEqual({ toolName: 'onehive_kleros_adapterStatus', input: binding });
    expect(await readKlerosAdapterStatus(binding, rpc())).toMatchObject({ arbitrationFeeRaw: '100', dispute: { disputeId: id, coreDisputeId: '7', finalised: false, agreementRuling: null } });
    expect(await readKlerosAdapterStatus(binding, rpc(true))).toMatchObject({ dispute: { finalised: true, agreementRuling: '4' } });
  });
  it('rejects mismatched fee recipients, unknown disputes and uint256 overflow', async () => {
    await expect(readKlerosAdapterStatus(binding, client({ honey: token, agreement, getDisputeFees: [core, token, 100n] }))).rejects.toThrow('mismatch');
    const missing = rpc(); vi.mocked(missing.readContract).mockImplementation(async ({ functionName }) => {
      if (functionName === 'disputes') return [0n, 0n, false, false] as never;
      return rpc().readContract({ functionName, address: core, abi: [] }) as never;
    });
    await expect(readKlerosAdapterStatus(binding, missing)).rejects.toThrow('Unknown');
    await expect(readKlerosAdapterStatus({ ...binding, disputeId: (2n ** 256n).toString() }, rpc())).rejects.toThrow('uint256');
    await expect(readKlerosAdapterStatus({ ...binding, disputeId: 123 } as never, rpc())).rejects.toThrow('uint256');
  });
  it('routes explicit Agreement acceptance through the existing unsigned builder', () => {
    expect(buildDispatch(['disputes', 'sign', '7', '--chain', '31337', '--from', core])).toMatchObject({
      toolName: 'onehive_celeste_signAgreementTx', input: { settingId: '7', chainId: 31337, from: core }
    });
  });
});

describe('Kleros stake preview', () => {
  const stake = { ...input, from: strategy, courtId: '1', amount: '10.000000000000000001' };
  it('encodes exact target stake, simulates without sending and keeps submission blocked', async () => {
    const rpc = client({ decimals: 18 });
    vi.mocked(rpc.simulateContract).mockResolvedValue({ status: 'success' });
    const tx = await buildKlerosStakeTx(stake, rpc);
    expect(decodeFunctionData({ abi: parseAbi(['function setStake(uint96,uint256)']), data: tx.data }).args)
      .toEqual([1n, 10000000000000000001n]);
    expect(tx.value).toBe('0');
    expect(tx.policy.checks).toContainEqual(expect.objectContaining({ name: 'abi-lock', status: 'fail' }));
    expect(tx.simulation.status).toBe('success');
    expect(rpc.sendTransaction).not.toHaveBeenCalled();
    expect(buildDispatch(['kleros', 'stake', '--chain', '31337', '--core', core, '--expected-token', token,
      '--from', strategy, '--court', '1', '--amount', stake.amount])).toEqual({ toolName: 'onehive_kleros_stakeTx', input: stake });
    expect(getOneHiveTool('onehive_kleros_stakeTx')).toBeDefined();
  });
  it('rejects rounding, overflow, signed amounts and wrong token decimals', async () => {
    for (const amount of ['0.0000000000000000001', '-1', '1e3', (2n ** 256n).toString()]) {
      await expect(buildKlerosStakeTx({ ...stake, amount }, client())).rejects.toThrow();
    }
    await expect(buildKlerosStakeTx({ ...stake, courtId: (2n ** 96n).toString() }, client())).rejects.toThrow('uint96');
    await expect(buildKlerosStakeTx(stake, client({ decimals: 6 }))).rejects.toThrow('18-decimal');
  });
  it('supports a zero target and sanitizes simulation failures', async () => {
    const rpc = client({ decimals: 18 });
    vi.mocked(rpc.simulateContract).mockResolvedValue({ status: 'revert', revertReason: 'https://test-user:fixture-password@example.invalid/rpc' });
    const tx = await buildKlerosStakeTx({ ...stake, amount: '0' }, rpc);
    expect(tx.decoded.args.newStake).toBe('0');
    expect(tx.simulation.status).toBe('revert');
    expect(JSON.stringify(tx)).not.toContain('secret');
    expect(tx.policy.checks).toContainEqual(expect.objectContaining({ name: 'simulation', status: 'fail' }));
  });
});
