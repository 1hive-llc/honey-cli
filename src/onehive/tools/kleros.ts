import { encodeFunctionData, parseUnits, isAddress, keccak256, parseAbi, zeroAddress } from 'viem';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { addressSchema, chainIdSchema } from '../schema-fields.js';
import { fail, ok, type ChainId, type HexAddress } from '../schemas.js';
import { buildTxPreview } from '../clients/tx.js';
import { simulateContractPreviewWithPolicy } from './tx-preflight.js';
import type { ToolDefinition } from '../tool-types.js';

// Read subset of the locally reviewed Honey/Kleros candidate; see KLEROS_COVERAGE.md.
const coreAbi = parseAbi([
  'function pinakion() view returns (address)',
  'function sortitionModule() view returns (address)',
  'function paused() view returns (bool)',
  'function arbitrationPaused() view returns (bool)',
  'function acceptedFeeTokens(address) view returns (bool)'
]);
const sortitionAbi = parseAbi([
  'function core() view returns (address)',
  'function stakeWeightStrategy() view returns (address)',
  'function totalStaked() view returns (uint256)'
]);

type KlerosStatusInput = { chainId: ChainId; core: HexAddress; expectedToken: HexAddress };
type KlerosStatusOutput = {
  chainId: ChainId;
  core: HexAddress;
  stakingToken: HexAddress;
  sortitionModule: HexAddress;
  stakeWeightStrategy: HexAddress;
  totalStakedRaw: string;
  honeyArbitrationFeesAccepted: boolean;
  paused: boolean;
  arbitrationPaused: boolean;
  codeHashes: Record<string, string>;
};

function requireAddress(value: unknown, name: string): asserts value is HexAddress {
  if (typeof value !== 'string' || !isAddress(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`${name} must be a nonzero address.`);
  }
}

export async function readKlerosStatus(input: KlerosStatusInput, suppliedClient?: ChainClient): Promise<KlerosStatusOutput> {
  if (![100, 10200, 31337].includes(input.chainId)) throw new Error('An explicit supported chainId is required.');
  requireAddress(input.core, 'core');
  requireAddress(input.expectedToken, 'expectedToken');
  const client = suppliedClient ?? createChainClientFromEnv(input.chainId);
  const actualChain = await client.getChainId();
  if (actualChain !== input.chainId) throw new Error(`RPC chain ${actualChain} does not match requested chain ${input.chainId}.`);
  const codeHashes: Record<string, string> = {};
  async function checkCode(address: HexAddress, name: string) {
    requireAddress(address, name);
    const code = await client.getBytecode(address);
    if (!code || code === '0x') throw new Error(`${name} has no deployed bytecode.`);
    codeHashes[name] = keccak256(code);
  }
  await checkCode(input.core, 'core');
  const [stakingToken, sortitionModule, paused, arbitrationPaused] = await Promise.all([
    client.readContract<HexAddress>({ address: input.core, abi: coreAbi, functionName: 'pinakion' }),
    client.readContract<HexAddress>({ address: input.core, abi: coreAbi, functionName: 'sortitionModule' }),
    client.readContract<boolean>({ address: input.core, abi: coreAbi, functionName: 'paused' }),
    client.readContract<boolean>({ address: input.core, abi: coreAbi, functionName: 'arbitrationPaused' })
  ]);
  requireAddress(stakingToken, 'stakingToken');
  if (stakingToken.toLowerCase() !== input.expectedToken.toLowerCase()) throw new Error('Kleros staking token does not match expectedToken.');
  const honeyArbitrationFeesAccepted = await client.readContract<boolean>({
    address: input.core, abi: coreAbi, functionName: 'acceptedFeeTokens', args: [input.expectedToken]
  });
  await checkCode(stakingToken, 'stakingToken');
  await checkCode(sortitionModule, 'sortitionModule');
  const [linkedCore, stakeWeightStrategy, totalStaked] = await Promise.all([
    client.readContract<HexAddress>({ address: sortitionModule, abi: sortitionAbi, functionName: 'core' }),
    client.readContract<HexAddress>({ address: sortitionModule, abi: sortitionAbi, functionName: 'stakeWeightStrategy' }),
    client.readContract<bigint>({ address: sortitionModule, abi: sortitionAbi, functionName: 'totalStaked' })
  ]);
  requireAddress(linkedCore, 'sortition core');
  if (linkedCore.toLowerCase() !== input.core.toLowerCase()) throw new Error('Sortition module points to a different core.');
  await checkCode(stakeWeightStrategy, 'stakeWeightStrategy');
  return { chainId: input.chainId, core: input.core, stakingToken, sortitionModule, stakeWeightStrategy,
    totalStakedRaw: totalStaked.toString(), honeyArbitrationFeesAccepted, paused, arbitrationPaused, codeHashes };
}

export const klerosStatusTool: ToolDefinition<KlerosStatusInput, KlerosStatusOutput> = {
  name: 'onehive_kleros_status',
  description: 'Inspect explicit Honey/Kleros candidate bindings without signing or changing deployment policy.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['chainId', 'core', 'expectedToken'],
    properties: { chainId: chainIdSchema, core: addressSchema, expectedToken: addressSchema }
  },
  async handler(input) {
    try {
      return ok(await readKlerosStatus(input), [
        'Read-only inspection of caller-supplied addresses, not an approved deployment or ABI/implementation verification. Proxy code hashes do not identify implementation code. Reads are not an atomic snapshot.',
        'Stake totals are raw token units. A configured strategy does not prove the selected Honey identity/weight rules; no signing or submission is enabled. ERC20 arbitration-fee acceptance does not establish Honey-funded appeal support.'
      ]);
    } catch {
      // RPC errors can contain credential-bearing endpoint URLs; do not forward them.
      return fail('kleros_status_failed', 'Kleros inspection failed. Check explicit chain, addresses, token/core linkage, candidate ABI and deployed code.', undefined, false);
    }
  }
};

export const adapterAbi = parseAbi([
  'function core() view returns (address)',
  'function honey() view returns (address)',
  'function agreement() view returns (address)',
  'function getDisputeFees() view returns (address recipient, address token, uint256 amount)',
  'function disputes(uint256) view returns (uint256 coreId, uint256 agreementRuling, bool exists, bool finalised)'
]);
type AdapterStatusInput = KlerosStatusInput & { adapter: HexAddress; agreement: HexAddress; disputeId?: string };

export async function readKlerosAdapterStatus(input: AdapterStatusInput, suppliedClient?: ChainClient) {
  requireAddress(input.adapter, 'adapter');
  requireAddress(input.agreement, 'agreement');
  if (input.disputeId !== undefined && (typeof input.disputeId !== 'string' || input.disputeId.length > 78 || !/^\d+$/.test(input.disputeId) || BigInt(input.disputeId) >= 2n ** 256n)) {
    throw new Error('disputeId must be an unsigned uint256 decimal string.');
  }
  const client = suppliedClient ?? createChainClientFromEnv(input.chainId);
  const context = await readKlerosStatus(input, client);
  for (const [name, address] of [['adapter', input.adapter], ['agreement', input.agreement]] as const) {
    const code = await client.getBytecode(address);
    if (!code || code === '0x') throw new Error(`${name} has no deployed bytecode.`);
    context.codeHashes[name] = keccak256(code);
  }
  const [core, honey, agreement, fees] = await Promise.all([
    client.readContract<HexAddress>({ address: input.adapter, abi: adapterAbi, functionName: 'core' }),
    client.readContract<HexAddress>({ address: input.adapter, abi: adapterAbi, functionName: 'honey' }),
    client.readContract<HexAddress>({ address: input.adapter, abi: adapterAbi, functionName: 'agreement' }),
    client.readContract<readonly [HexAddress, HexAddress, bigint]>({ address: input.adapter, abi: adapterAbi, functionName: 'getDisputeFees' })
  ]);
  if (core.toLowerCase() !== input.core.toLowerCase() || honey.toLowerCase() !== input.expectedToken.toLowerCase()
    || agreement.toLowerCase() !== input.agreement.toLowerCase() || fees[0].toLowerCase() !== input.adapter.toLowerCase()
    || fees[1].toLowerCase() !== input.expectedToken.toLowerCase()) throw new Error('Adapter bindings or fee recipient/token mismatch.');
  let dispute;
  if (input.disputeId !== undefined) {
    const [coreId, ruling, exists, finalised] = await client.readContract<readonly [bigint, bigint, boolean, boolean]>({
      address: input.adapter, abi: adapterAbi, functionName: 'disputes', args: [BigInt(input.disputeId)]
    });
    if (!exists) throw new Error('Unknown adapter dispute.');
    if (finalised && (ruling < 2n || ruling > 4n)) throw new Error('Unexpected Agreement ruling.');
    dispute = { disputeId: input.disputeId, coreDisputeId: coreId.toString(), finalised,
      agreementRuling: finalised ? ruling.toString() : null };
  }
  return { ...context, adapter: input.adapter, agreement: input.agreement,
    arbitrationFeeRaw: fees[2].toString(), ...(dispute ? { dispute } : {}) };
}

export const klerosAdapterStatusTool: ToolDefinition<AdapterStatusInput, Awaited<ReturnType<typeof readKlerosAdapterStatus>>> = {
  name: 'onehive_kleros_adapterStatus',
  description: 'Read explicit Agreement/Honey/Kleros bridge bindings, current fees and optional final ruling.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['chainId', 'core', 'expectedToken', 'adapter', 'agreement'],
    properties: { chainId: chainIdSchema, core: addressSchema, expectedToken: addressSchema,
      adapter: addressSchema, agreement: addressSchema, disputeId: { type: 'string', pattern: '^\\d+$' } } },
  async handler(input) {
    try {
      return ok(await readKlerosAdapterStatus(input), [
        'Read-only caller-supplied bindings, not implementation attestation or switch authorization. Fee quotes may change. Reads are not atomic.',
        'A final adapter ruling does not prove Agreement.resolve or proposal execution occurred. Rulings: 2 void, 3 challenger, 4 submitter.'
      ]);
    } catch {
      return fail('kleros_adapter_status_failed', 'Adapter inspection failed. Check chain, explicit bindings, deployed code and dispute ID.', undefined, false);
    }
  }
};

const stakeAbi = parseAbi(['function setStake(uint96 courtID, uint256 newStake)']);
type StakeInput = KlerosStatusInput & { from: HexAddress; courtId: string; amount: string };

export async function buildKlerosStakeTx(input: StakeInput, suppliedClient?: ChainClient) {
  requireAddress(input.from, 'from');
  if (typeof input.courtId !== 'string' || !/^\d{1,29}$/.test(input.courtId) || BigInt(input.courtId) >= 2n ** 96n) {
    throw new Error('courtId must be an unsigned uint96 decimal string.');
  }
  if (typeof input.amount !== 'string' || input.amount.length > 79 || !/^\d+(\.\d{1,18})?$/.test(input.amount)) {
    throw new Error('amount must be a nonnegative Honey amount with at most 18 decimal places.');
  }
  const amount = parseUnits(input.amount, 18);
  if (amount >= 2n ** 256n) throw new Error('amount exceeds uint256.');
  const client = suppliedClient ?? createChainClientFromEnv(input.chainId);
  await readKlerosStatus(input, client);
  const decimals = await client.readContract<number>({ address: input.expectedToken,
    abi: parseAbi(['function decimals() view returns (uint8)']), functionName: 'decimals' });
  if (decimals !== 18) throw new Error('Expected an 18-decimal Honey token.');
  const args = [BigInt(input.courtId), amount] as const;
  const preview = buildTxPreview({ chainId: input.chainId, from: input.from, to: input.core,
    data: encodeFunctionData({ abi: stakeAbi, functionName: 'setStake', args }),
    contractName: 'Honey Kleros Core', method: 'setStake',
    args: { courtID: input.courtId, newStake: amount.toString() },
    humanSummary: `Set court ${input.courtId} target stake to ${input.amount} HNY. This is the total target, not an additional deposit. Zero requests unstaking; changes may be delayed and locked stake may remain.`, risk: 'high' });
  const result = await simulateContractPreviewWithPolicy({ client, preview, abi: stakeAbi,
    functionName: 'setStake', args: [...args], account: input.from,
    policy: { abiLockStatus: 'missing', methodSelectorKnown: false } });
  // Do not expose RPC-provided revert text, which can contain endpoint credentials.
  if (result.simulation.status === 'revert') result.simulation.revertReason = 'Candidate stake simulation reverted. Check court eligibility, balance, allowance, minimum stake and pause state.';
  return result;
}

export const klerosStakeTool: ToolDefinition<StakeInput, Awaited<ReturnType<typeof buildKlerosStakeTx>>> = {
  name: 'onehive_kleros_stakeTx',
  description: 'Build and simulate an unsigned Honey juror target-stake preview. Candidate submission remains blocked pending a deployment ABI lock.',
  inputSchema: { type: 'object', additionalProperties: false,
    required: ['chainId', 'core', 'expectedToken', 'from', 'courtId', 'amount'],
    properties: { chainId: chainIdSchema, core: addressSchema, expectedToken: addressSchema, from: addressSchema,
      courtId: { type: 'string', pattern: '^\\d{1,29}$' }, amount: { type: 'string', pattern: '^\\d+(\\.\\d{1,18})?$' } } },
  async handler(input) {
    try {
      return ok(await buildKlerosStakeTx(input), [
        'Unsigned preview only. Candidate addresses are not ABI-locked or approved for submission, even if simulation succeeds.',
        'Increasing stake requires Honey balance and allowance to Core. This command does not approve tokens. Successful simulation may queue a change rather than immediately changing stake.'
      ]);
    } catch {
      return fail('kleros_stake_preview_failed', 'Stake preview failed. Check explicit chain, addresses, Honey linkage, court ID and amount (at most 18 decimals).', undefined, false);
    }
  }
};
