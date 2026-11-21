import { decodeFunctionData, encodeFunctionResult, type Abi, type Address, zeroAddress } from 'viem';
import { expect, it, vi } from 'vitest';
import { adapterAbi, coreAbi, eligibilityAbi, sortitionAbi, strategyAbi } from '../../src/kleros-court/abis.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { TOKENS } from '../../src/onehive/addresses.js';
import { parseProfile } from '../../src/web/profile.js';
import { queryStake, type StakeDeps } from '../../src/web/stake.js';

const [account, adapter, core, sortition, roster, strategy] = [1, 2, 3, 4, 5, 6].map(
  n => ('0x' + String(n).repeat(40)) as Address) as [Address, Address, Address, Address, Address, Address];
const hash = `0x${'ba'.repeat(32)}` as const;
const env = { HONEY_WEB_CHAIN_ID: '31337', FORK_RPC_URL: 'http://127.0.0.1:8545',
  HONEY_WEB_ADAPTER: adapter, HONEY_WEB_STAKE_CORE: core, HONEY_WEB_STAKE_COURT_ID: '1' };
const p = parseProfile(env);
const unit = 10n ** 18n;
const input = { account, target: '51.000000000000000001', blockHash: hash };
function mock({ phase = 0, eligible = true, allowance = 20n * unit, moduleCore = core,
  coreToken = TOKENS.HNY as Address, reject = false }: { phase?: number; eligible?: boolean; allowance?: bigint;
    moduleCore?: Address; coreToken?: Address; reject?: boolean } = {}) {
  const targets = new Map<Address, [Abi, Record<string, unknown>]>([
    [adapter, [adapterAbi, { core, honey: TOKENS.HNY }]],
    [core, [coreAbi, { pinakion: coreToken, sortitionModule: sortition, paused: false, jurorNft: zeroAddress,
      courts: [0n, 10n * unit, 0n, 0n, roster] }]],
    [roster, [eligibilityAbi, { isEligible: eligible }]],
    [sortition, [sortitionAbi, { core: moduleCore, phase, getJurorBalance: [50n * unit, 12n * unit, 50n * unit, 1n],
      stakeWeightStrategy: strategy, stakeIdentityOfWallet: account, totalStaked: 50n * unit,
      maxStakePerJuror: 100n * unit, maxTotalStaked: 1000n * unit }]],
    [strategy, [strategyAbi, { usesIdentityWeight: true, identityOf: account }]],
    [TOKENS.HNY, [erc20Abi, { decimals: 18, balanceOf: 30n * unit, allowance }]]
  ]);
  const call = vi.fn<StakeDeps['call']>(async ({ from, to, data }, canonical) => {
    expect(canonical).toBe(hash);
    const [abi, results] = targets.get(to)!;
    const decoded = decodeFunctionData({ abi, data });
    if (decoded.functionName === 'setStake') {
      expect([from, to, decoded.args]).toEqual([account, core, [1n, 51n * unit + 1n]]);
      if (reject) throw new Error('not for public output');
      return '0x';
    }
    expect(from).toBeUndefined();
    expect(results).toHaveProperty(decoded.functionName);
    return encodeFunctionResult({ abi, functionName: decoded.functionName, result: results[decoded.functionName] });
  });
  return { chain: async () => 31337, block: async () => ({ hash, number: 10n, timestamp: 20n }), call };
}

it('reads the configured court and separates court stake, locked HNY, and token allowance', async () => {
  const rpc = mock();
  expect(await queryStake(p, { account }, rpc)).toMatchObject({ account, blockHash: hash, courtId: '1', eligible: true,
    currentStakeRaw: String(50n * unit), totalLockedRaw: String(12n * unit), minimumStakeRaw: String(10n * unit),
    balanceRaw: String(30n * unit), allowanceRaw: String(20n * unit) });
  expect(rpc.call.mock.calls.every(([req]) => !req.from)).toBe(true);
});

it.each([[0, 'immediate'], [1, 'delayed'], [2, 'delayed']] as const)(
  'pins the getter reads and actor-specific simulation in phase %s, without returning signing data', async (phase, delivery) => {
    const rpc = mock({ phase });
    const preview = await queryStake(p, input, rpc);
    expect(preview).toMatchObject({ account, blockHash: hash, delivery, submitted: false, targetStakeRaw: String(51n * unit + 1n) });
    expect(rpc.call.mock.calls.filter(([req]) => !!req.from)).toHaveLength(1);
    expect(JSON.stringify(preview)).not.toMatch(/"data"|"preview"|"signature"/);
  });

it('rejects stale previews before any contract read and disables previews on a remote profile', async () => {
  const rpc = mock();
  await expect(queryStake(p, { ...input, blockHash: '0x' + 'ab'.repeat(32) }, rpc)).rejects.toMatchObject({ code: 'stake-stale' });
  await expect(queryStake(parseProfile({ ...env, FORK_RPC_URL: 'https://rpc.example' }), input, rpc)).rejects
    .toMatchObject({ code: 'stake-not-ready' });
  expect(rpc.call).not.toHaveBeenCalled();
});

it.each([{ eligible: false }, { allowance: unit }])('blocks planner rejection before simulation: %o', async (options) => {
  const rpc = mock(options);
  await expect(queryStake(p, input, rpc)).rejects.toMatchObject({ code: 'stake-not-ready' });
  expect(rpc.call.mock.calls.every(([req]) => !req.from)).toBe(true);
});

it('fails closed for linkage mismatch or a reverted call', async () => {
  await expect(queryStake(p, { account }, mock({ moduleCore: adapter }))).rejects.toMatchObject({ code: 'unavailable' });
  await expect(queryStake(p, { account }, mock({ coreToken: adapter }))).rejects.toMatchObject({ code: 'unavailable' });
  await expect(queryStake(p, input, mock({ reject: true }))).rejects.toMatchObject({ code: 'simulation' });
});

it('requires both court settings, a configured adapter and a nonzero uint96 court ID', () => {
  for (const patch of [{ HONEY_WEB_STAKE_CORE: '' }, { HONEY_WEB_ADAPTER: '' }, { HONEY_WEB_STAKE_COURT_ID: '0' },
    { HONEY_WEB_STAKE_COURT_ID: String(2n ** 96n) }]) expect(() => parseProfile({ ...env, ...patch })).toThrow();
});
