import { encodeFunctionData, encodePacked, isHex, keccak256 } from 'viem';
import { request } from 'graphql-request';
import { parseHnyAmount } from '../amounts.js';
import { celesteCourtAbi } from '../abis/celesteCourt.js';
import { celesteDisputeManagerAbi } from '../abis/celesteDisputeManager.js';
import { celesteRegistryAbi } from '../abis/celesteRegistry.js';
import { celesteVotingAbi } from '../abis/celesteVoting.js';
import { erc20Abi } from '../abis/erc20.js';
import { CELESTE, TOKENS, addressFromEnvOrReference } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { buildTxPreview } from '../clients/tx.js';
import type { ToolDefinition } from '../tool-types.js';
import { evaluateTxPolicy } from '../policy.js';
import { simulateContractPreviewWithPolicy } from './tx-preflight.js';
import { addressPattern, fail, ok, type ChainId, type HexAddress, type OneHiveToolResult, type TxPreview } from '../schemas.js';
import { amountStringSchema, bytes32Schema, chainIdSchema, commonTxFields, hexBytesSchema, uintIdSchema, addressSchema } from '../schema-fields.js';

const GNOSIS_CHAIN_ID = 100 as const;
const DEFAULT_HEARTBEAT_MAX_TRANSITIONS = 20;
const MAX_HEARTBEAT_TRANSITIONS = 200;

export type CourtStatusInput = { chainId?: ChainId; verifyCode?: boolean };
export type CourtHeartbeatTxInput = { maxTransitions?: number; from?: HexAddress; chainId?: ChainId };
export type CourtSubgraphStatusInput = { chainId?: ChainId; celesteSubgraphUrl?: string; agreementSubgraphUrl?: string; maxIndexedAgeSeconds?: number };
export type CourtStakeTxInput = { amountHny: string; juror?: HexAddress; data?: string; from?: HexAddress; chainId?: ChainId };
export type CourtTokenActivationTxInput = { amountHny: string; from?: HexAddress; chainId?: ChainId };
export type CourtCommitTxInput = { voteId?: string | number; disputeId?: string | number; roundId?: string | number; commitment?: `0x${string}`; outcome?: string | number; salt?: `0x${string}`; from?: HexAddress; chainId?: ChainId };
export type CourtRevealTxInput = { voteId?: string | number; disputeId?: string | number; roundId?: string | number; juror?: HexAddress; outcome: string | number; salt?: `0x${string}`; from?: HexAddress; chainId?: ChainId };
export type CourtAppealTxInput = { disputeId: string | number; roundId?: string | number; outcome?: string | number; ruling?: string | number; confirm?: boolean; mode?: 'create' | 'confirm'; from?: HexAddress; chainId?: ChainId };
export type CourtRewardsInput = { disputeId: string | number; roundId?: string | number; juror?: HexAddress; from?: HexAddress; chainId?: ChainId };
export type CourtRewardsOutput = { disputeId: string; juror: HexAddress; rounds: Array<{ roundId: string; weight: string; rewarded: boolean; claimable: boolean }>; claimableRounds: string[] };

export type CourtStatusOutput = {
  chainId: ChainId;
  court: HexAddress;
  currentTermId: string;
  termDuration: string;
  neededTermTransitions: string;
  needsHeartbeat: boolean;
  hasCode?: boolean;
};

export type SubgraphEndpointStatus = {
  name: 'celeste' | 'agreement';
  urlConfigured: boolean;
  ok: boolean;
  source?: 'cli' | 'env-url' | 'graph-gateway-id' | 'missing';
  redactedUrl?: string;
  error?: string;
  indexedCurrentTerm?: string;
  rpcCurrentTerm?: string;
  termLag?: string;
  latestIndexedTimestamp?: string;
  latestIndexedAgeSeconds?: string;
  stale?: boolean;
  sampleId?: string;
  fieldsAvailable?: string[];
  missingFields?: string[];
};

export type CourtSubgraphStatusOutput = {
  chainId: ChainId;
  rpcCurrentTermId?: string;
  endpoints: SubgraphEndpointStatus[];
};

type GraphRequestFn = <T>(url: string, query: string) => Promise<T>;

type CourtDeps = { client?: ChainClient; graphRequest?: GraphRequestFn; now?: Date };

function courtAddress(): HexAddress {
  return addressFromEnvOrReference('CELESTE_COURT', 'celeste', 'court', CELESTE.COURT);
}

function registryAddress(): HexAddress {
  return addressFromEnvOrReference('CELESTE_REGISTRY', 'celeste', 'registry', CELESTE.REGISTRY);
}

function hnyAddress(): HexAddress {
  return addressFromEnvOrReference('ONEHIVE_HNY', 'tokens', 'HNY', TOKENS.HNY);
}

function optionalAccount(from?: HexAddress): HexAddress | undefined {
  return from ?? (process.env.AGENT_WALLET_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(process.env.AGENT_WALLET_ADDRESS)
    ? process.env.AGENT_WALLET_ADDRESS as HexAddress
    : undefined);
}

async function assertChain(client: ChainClient, chainId: ChainId): Promise<void> {
  const active = await client.getChainId();
  if (active !== chainId) throw new Error(`RPC endpoint is connected to chain ${active}, requested ${chainId}.`);
}

function normalizeBytes(value: string | undefined): `0x${string}` {
  if (!value) return '0x';
  if (!/^0x[a-fA-F0-9]*$/.test(value)) throw new Error('data must be a hex string.');
  return value as `0x${string}`;
}

function parseNonNegativeId(value: string | number | undefined, label: string): bigint {
  if (value === undefined) throw new Error(`${label} is required.`);
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer.`);
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a non-negative integer string.`);
  return BigInt(value);
}

function voteIdFromInput(input: Pick<CourtCommitTxInput, 'voteId' | 'disputeId' | 'roundId'>): bigint {
  if (input.voteId !== undefined) return parseNonNegativeId(input.voteId, 'voteId');
  const disputeId = parseNonNegativeId(input.disputeId, 'disputeId');
  const roundId = parseNonNegativeId(input.roundId, 'roundId');
  return (2n ** 128n * disputeId) + roundId;
}

function normalizeBytes32(value: string, label: string): `0x${string}` {
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${label} must be a 32-byte hex string.`);
  return value as `0x${string}`;
}

function saltFromInput(input: Pick<CourtCommitTxInput | CourtRevealTxInput, 'salt'>): `0x${string}` {
  if (input.salt) return normalizeBytes32(input.salt, 'salt');
  throw new Error('salt is required. Pass an explicit 32-byte --salt value; password-derived salts are not accepted because CLI passwords can leak through shell history or process lists.');
}

function normalizeOutcome(outcomeInput: string | number | undefined, label = 'outcome'): number {
  if (outcomeInput === undefined) throw new Error(`${label} is required.`);
  const outcome = Number(outcomeInput);
  if (!Number.isInteger(outcome) || outcome < 0 || outcome > 255) throw new Error(`${label} must be an integer from 0 to 255.`);
  return outcome;
}

function commitmentFromInput(input: CourtCommitTxInput): `0x${string}` {
  if (input.commitment) return normalizeBytes32(input.commitment, 'commitment');
  const outcome = normalizeOutcome(input.outcome);
  return keccak256(encodePacked(['uint8', 'bytes32'], [outcome, saltFromInput(input)]));
}

function normalizeTransitions(value: number | undefined, needed?: bigint): bigint {
  let normalized = value ?? DEFAULT_HEARTBEAT_MAX_TRANSITIONS;
  if (!Number.isFinite(normalized) || !Number.isInteger(normalized) || normalized < 1) normalized = DEFAULT_HEARTBEAT_MAX_TRANSITIONS;
  if (normalized > MAX_HEARTBEAT_TRANSITIONS) normalized = MAX_HEARTBEAT_TRANSITIONS;
  const requested = BigInt(normalized);
  return needed !== undefined && needed > 0n && requested > needed ? needed : requested;
}

export async function readCourtStatus(input: CourtStatusInput = {}, deps: CourtDeps = {}): Promise<OneHiveToolResult<CourtStatusOutput>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const address = courtAddress();
    const [currentTermId, termDuration, neededTermTransitions, bytecode] = await Promise.all([
      client.readContract<bigint>({ address, abi: celesteCourtAbi, functionName: 'getCurrentTermId' }),
      client.readContract<bigint>({ address, abi: celesteCourtAbi, functionName: 'getTermDuration' }),
      client.readContract<bigint>({ address, abi: celesteCourtAbi, functionName: 'getNeededTermTransitions' }),
      input.verifyCode ? client.getBytecode(address) : Promise.resolve(undefined)
    ]);
    const warnings = neededTermTransitions > 0n ? [`Celeste court needs ${neededTermTransitions.toString()} term transition(s); run honey court heartbeat --preview before keeper/dispute operations that require a fresh term.`] : [];
    const output: CourtStatusOutput = {
      chainId,
      court: address,
      currentTermId: currentTermId.toString(),
      termDuration: termDuration.toString(),
      neededTermTransitions: neededTermTransitions.toString(),
      needsHeartbeat: neededTermTransitions > 0n
    };
    if (input.verifyCode) output.hasCode = Boolean(bytecode && bytecode !== '0x');
    return ok(output, warnings);
  } catch (error) {
    return fail('court_status_failed', error instanceof Error ? error.message : 'Failed to read Honey court status.', undefined, true);
  }
}

export async function buildCourtHeartbeatPreview(input: CourtHeartbeatTxInput = {}, deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court heartbeat previews.', undefined, false);
    const address = courtAddress();
    const needed = await client.readContract<bigint>({ address, abi: celesteCourtAbi, functionName: 'getNeededTermTransitions' });
    if (needed === 0n) return fail('heartbeat_not_needed', 'Celeste court does not need any term transitions.', { neededTermTransitions: '0' }, false);
    const maxTransitions = normalizeTransitions(input.maxTransitions, needed);
    const args = [maxTransitions] as [bigint];
    const data = encodeFunctionData({ abi: celesteCourtAbi, functionName: 'heartbeat', args });
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: address,
      data,
      contractName: 'CelesteCourt',
      method: 'heartbeat',
      args: { maxTransitions: maxTransitions.toString(), neededTermTransitions: needed.toString() },
      humanSummary: `Advance the Celeste court clock by up to ${maxTransitions.toString()} term transition(s); ${needed.toString()} transition(s) are currently needed.`,
      risk: 'medium'
    });
    const code = await client.getBytecode(address);
    const simulation = await client.simulateContract({ account, address, abi: celesteCourtAbi, functionName: 'heartbeat', args });
    preview.simulation = simulation.status === 'success'
      ? { status: 'success', ...(simulation.gasEstimate !== undefined ? { gasEstimate: simulation.gasEstimate.toString() } : {}) }
      : { status: 'revert', ...(simulation.revertReason !== undefined ? { revertReason: simulation.revertReason } : {}) };
    preview.policy.checks = evaluateTxPolicy(preview, {
      chainId,
      allowTestnetWrites: chainId !== 100,
      methodSelectorKnown: true,
      targetHasCode: Boolean(code && code !== '0x'),
      abiLockStatus: 'match',
      simulationStatus: preview.simulation.status
    });
    if (preview.simulation.status === 'revert') return fail('simulation_reverted', 'heartbeat simulation reverted.', preview, false);
    return ok(preview, ['Heartbeat updates the Celeste court term. It can change keeper/dispute phase availability; review current term and needed transitions before submitting.']);
  } catch (error) {
    return fail('court_heartbeat_preview_failed', error instanceof Error ? error.message : 'Failed to build Honey court heartbeat preview.', undefined, true);
  }
}

async function simulateRegistryPreview(client: ChainClient, preview: TxPreview, functionName: string, args: unknown[], account: HexAddress): Promise<TxPreview> {
  return simulateContractPreviewWithPolicy({ client, preview, abi: celesteRegistryAbi, functionName, args, account });
}

export async function buildCourtStakePreview(input: CourtStakeTxInput, deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court staking previews.', undefined, false);
    const amount = parseHnyAmount(input.amountHny);
    const registry = registryAddress();
    const hny = hnyAddress();
    const allowance = await client.readContract<bigint>({ address: hny, abi: erc20Abi, functionName: 'allowance', args: [account, registry] });
    if (allowance < amount) return fail('missing_allowance', 'HNY allowance for Celeste registry is below the staking amount. Build an exact HNY approval preview first.', { token: hny, spender: registry, allowance: allowance.toString(), requiredAllowance: amount.toString() }, false);
    const juror = input.juror ?? account;
    const dataBytes = normalizeBytes(input.data);
    const args = [juror, amount, dataBytes] as [HexAddress, bigint, `0x${string}`];
    const data = encodeFunctionData({ abi: celesteRegistryAbi, functionName: 'stakeFor', args });
    const preview = buildTxPreview({ chainId, from: account, to: registry, data, contractName: 'CelesteJurorsRegistry', method: 'stakeFor', args: { juror, amountHny: input.amountHny, amountWei: amount.toString(), data: dataBytes }, humanSummary: `Stake ${input.amountHny} HNY into Celeste court registry for juror ${juror}.`, risk: 'high' });
    const simulated = await simulateRegistryPreview(client, preview, 'stakeFor', args, account);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'stakeFor simulation reverted.', simulated, false);
    return ok(simulated, ['Staked HNY may need to be activated before it counts for Celeste drafting. Keeper participation can create voting/reveal duties and missed-duty penalties.']);
  } catch (error) {
    return fail('court_stake_preview_failed', error instanceof Error ? error.message : 'Failed to build Honey court stake preview.', undefined, true);
  }
}

export async function buildCourtTokenActivationPreview(input: CourtTokenActivationTxInput, action: 'activate' | 'deactivate' | 'unstake', deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', `A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court ${action} previews.`, undefined, false);
    const amount = parseHnyAmount(input.amountHny);
    const registry = registryAddress();
    const args = action === 'unstake' ? [amount, '0x' as `0x${string}`] as [bigint, `0x${string}`] : [amount] as [bigint];
    const data = encodeFunctionData({ abi: celesteRegistryAbi, functionName: action, args } as Parameters<typeof encodeFunctionData>[0]);
    const risk = action === 'activate' ? 'high' : 'medium';
    const preview = buildTxPreview({ chainId, from: account, to: registry, data, contractName: 'CelesteJurorsRegistry', method: action, args: { amountHny: input.amountHny, amountWei: amount.toString() }, humanSummary: `${action[0]?.toUpperCase()}${action.slice(1)} ${input.amountHny} HNY in the Celeste court registry.`, risk });
    const simulated = await simulateRegistryPreview(client, preview, action, args, account);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', `${action} simulation reverted.`, simulated, false);
    const warnings = action === 'activate'
      ? ['Activated HNY increases keeper drafting weight and can create voting/reveal duties with missed-duty penalties.']
      : [`${action} may be unavailable for locked/challenged HNY or active dispute duties; simulation is the source of truth.`];
    return ok(simulated, warnings);
  } catch (error) {
    return fail(`court_${action}_preview_failed`, error instanceof Error ? error.message : `Failed to build Honey court ${action} preview.`, undefined, true);
  }
}

async function simulateVotingPreview(client: ChainClient, preview: TxPreview, functionName: string, args: unknown[], account: HexAddress, voting: HexAddress): Promise<TxPreview> {
  return simulateContractPreviewWithPolicy({ client, preview, abi: celesteVotingAbi, functionName, args, account, policy: { additionalAllowlistedTargets: [voting] } });
}

export async function buildCourtCommitPreview(input: CourtCommitTxInput, deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court commit previews.', undefined, false);
    const voteId = voteIdFromInput(input);
    const commitment = commitmentFromInput(input);
    const voting = await client.readContract<HexAddress>({ address: courtAddress(), abi: celesteCourtAbi, functionName: 'getVoting' });
    const args = [voteId, commitment] as [bigint, `0x${string}`];
    const data = encodeFunctionData({ abi: celesteVotingAbi, functionName: 'commit', args });
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: voting,
      data,
      contractName: 'CelesteVoting',
      method: 'commit',
      args: { voteId: voteId.toString(), commitment },
      humanSummary: `Commit a sealed Honey/Celeste keeper vote for vote ID ${voteId.toString()}. Keep the salt and outcome; they are required for reveal.`,
      risk: 'high'
    });
    const simulated = await simulateVotingPreview(client, preview, 'commit', args, account, voting);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'commit simulation reverted.', simulated, false);
    return ok(simulated, ['Commit/reveal votes are keeper duties. Store your outcome and salt securely; missing the reveal phase can incur Celeste penalties. Do not pass keeper secrets through shell history.']);
  } catch (error) {
    return fail('court_commit_preview_failed', error instanceof Error ? error.message : 'Failed to build Honey court commit preview.', undefined, true);
  }
}

export async function buildCourtRevealPreview(input: CourtRevealTxInput, deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court reveal previews.', undefined, false);
    const voteId = voteIdFromInput(input);
    const outcome = normalizeOutcome(input.outcome);
    const salt = saltFromInput(input);
    const juror = input.juror ?? account;
    const voting = await client.readContract<HexAddress>({ address: courtAddress(), abi: celesteCourtAbi, functionName: 'getVoting' });
    const validOutcome = await client.readContract<boolean>({ address: voting, abi: celesteVotingAbi, functionName: 'isValidOutcome', args: [voteId, outcome] }).catch(() => true);
    if (!validOutcome) return fail('invalid_outcome', `Outcome ${outcome} is not valid for vote ID ${voteId.toString()}.`, { voteId: voteId.toString(), outcome }, false);
    const args = [voteId, juror, outcome, salt] as [bigint, HexAddress, number, `0x${string}`];
    const data = encodeFunctionData({ abi: celesteVotingAbi, functionName: 'reveal', args });
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: voting,
      data,
      contractName: 'CelesteVoting',
      method: 'reveal',
      args: { voteId: voteId.toString(), juror, outcome, salt },
      humanSummary: `Reveal Honey/Celeste keeper vote outcome ${outcome} for juror ${juror} on vote ID ${voteId.toString()}.`,
      risk: 'high'
    });
    const simulated = await simulateVotingPreview(client, preview, 'reveal', args, account, voting);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'reveal simulation reverted.', simulated, false);
    return ok(simulated, ['Revealing publishes the outcome and salt on-chain. Reveal during the required phase to avoid missed-reveal penalties.']);
  } catch (error) {
    return fail('court_reveal_preview_failed', error instanceof Error ? error.message : 'Failed to build Honey court reveal preview.', undefined, true);
  }
}

function tupleValue<T>(value: unknown, index: number, key: string): T {
  if (Array.isArray(value)) return value[index] as T;
  if (value && typeof value === 'object' && key in value) return (value as Record<string, unknown>)[key] as T;
  throw new Error(`Unable to read ${key} from contract response.`);
}

async function disputeManagerAddress(client: ChainClient): Promise<HexAddress> {
  return client.readContract<HexAddress>({ address: courtAddress(), abi: celesteCourtAbi, functionName: 'getDisputeManager' });
}

async function simulateDisputeManagerPreview(client: ChainClient, preview: TxPreview, functionName: string, args: unknown[], account: HexAddress, disputeManager: HexAddress): Promise<TxPreview> {
  return simulateContractPreviewWithPolicy({ client, preview, abi: celesteDisputeManagerAbi, functionName, args, account, policy: { additionalAllowlistedTargets: [disputeManager] } });
}

export async function buildCourtAppealPreview(input: CourtAppealTxInput, deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court appeal previews.', undefined, false);
    const disputeId = parseNonNegativeId(input.disputeId, 'disputeId');
    const ruling = normalizeOutcome(input.ruling ?? input.outcome, 'ruling');
    const mode: 'create' | 'confirm' = input.mode ?? (input.confirm ? 'confirm' : 'create');
    const disputeManager = await disputeManagerAddress(client);
    const dispute = await client.readContract<unknown>({ address: disputeManager, abi: celesteDisputeManagerAbi, functionName: 'getDispute', args: [disputeId] });
    const roundId = input.roundId !== undefined ? parseNonNegativeId(input.roundId, 'roundId') : tupleValue<bigint>(dispute, 4, 'lastRoundId');
    const nextRound = await client.readContract<unknown>({ address: disputeManager, abi: celesteDisputeManagerAbi, functionName: 'getNextRoundDetails', args: [disputeId, roundId] });
    const feeToken = tupleValue<HexAddress>(nextRound, 3, 'feeToken');
    const deposit = mode === 'confirm' ? tupleValue<bigint>(nextRound, 7, 'confirmAppealDeposit') : tupleValue<bigint>(nextRound, 6, 'appealDeposit');
    const allowance = await client.readContract<bigint>({ address: feeToken, abi: erc20Abi, functionName: 'allowance', args: [account, disputeManager] });
    if (allowance < deposit) return fail('missing_allowance', `Fee-token allowance for Celeste dispute manager is below the ${mode === 'confirm' ? 'confirm appeal' : 'appeal'} deposit. Build an exact approval preview first.`, { token: feeToken, spender: disputeManager, allowance: allowance.toString(), requiredAllowance: deposit.toString() }, false);
    const functionName = mode === 'confirm' ? 'confirmAppeal' : 'createAppeal';
    const args = [disputeId, roundId, ruling] as [bigint, bigint, number];
    const data = encodeFunctionData({ abi: celesteDisputeManagerAbi, functionName, args });
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: disputeManager,
      data,
      contractName: 'CelesteDisputeManager',
      method: functionName,
      args: { disputeId: disputeId.toString(), roundId: roundId.toString(), ruling, feeToken, deposit: deposit.toString() },
      humanSummary: `${mode === 'confirm' ? 'Confirm appeal' : 'Appeal'} Honey/Celeste dispute ${disputeId.toString()} round ${roundId.toString()} in favor of ruling ${ruling}.`,
      risk: 'high'
    });
    const simulated = await simulateDisputeManagerPreview(client, preview, functionName, args, account, disputeManager);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', `${functionName} simulation reverted.`, simulated, false);
    return ok(simulated, [`Appeals require an upfront fee-token deposit (${deposit.toString()} wei of ${feeToken}) and can escalate dispute exposure. Confirming an appeal creates the next adjudication round.`]);
  } catch (error) {
    return fail('court_appeal_preview_failed', error instanceof Error ? error.message : 'Failed to build Honey court appeal preview.', undefined, true);
  }
}

export async function readCourtRewards(input: CourtRewardsInput, deps: CourtDeps = {}): Promise<OneHiveToolResult<CourtRewardsOutput>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const juror = input.juror ?? optionalAccount(input.from);
    if (!juror) return fail('juror_required', 'A juror address, from address, or AGENT_WALLET_ADDRESS is required to read Honey court rewards.', undefined, false);
    const disputeId = parseNonNegativeId(input.disputeId, 'disputeId');
    const disputeManager = await disputeManagerAddress(client);
    const dispute = await client.readContract<unknown>({ address: disputeManager, abi: celesteDisputeManagerAbi, functionName: 'getDispute', args: [disputeId] });
    const lastRoundId = tupleValue<bigint>(dispute, 4, 'lastRoundId');
    const roundsToRead = input.roundId !== undefined ? [parseNonNegativeId(input.roundId, 'roundId')] : Array.from({ length: Number(lastRoundId) + 1 }, (_, index) => BigInt(index));
    const rounds = [] as CourtRewardsOutput['rounds'];
    for (const roundId of roundsToRead) {
      const jurorState = await client.readContract<unknown>({ address: disputeManager, abi: celesteDisputeManagerAbi, functionName: 'getJuror', args: [disputeId, roundId, juror] });
      const weight = tupleValue<bigint>(jurorState, 0, 'weight');
      const rewarded = tupleValue<boolean>(jurorState, 1, 'rewarded');
      rounds.push({ roundId: roundId.toString(), weight: weight.toString(), rewarded, claimable: weight > 0n && !rewarded });
    }
    return ok({ disputeId: disputeId.toString(), juror, rounds, claimableRounds: rounds.filter((round) => round.claimable).map((round) => round.roundId) }, ['Reward status is eligibility-oriented. Final claimability still depends on dispute/round settlement state; use claim-rewards preview simulation before submitting.']);
  } catch (error) {
    return fail('court_rewards_failed', error instanceof Error ? error.message : 'Failed to read Honey court rewards.', undefined, true);
  }
}

export async function buildCourtClaimRewardsPreview(input: CourtRewardsInput, deps: CourtDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Honey court reward claim previews.', undefined, false);
    const juror = input.juror ?? account;
    const disputeId = parseNonNegativeId(input.disputeId, 'disputeId');
    const disputeManager = await disputeManagerAddress(client);
    const dispute = await client.readContract<unknown>({ address: disputeManager, abi: celesteDisputeManagerAbi, functionName: 'getDispute', args: [disputeId] });
    const roundId = input.roundId !== undefined ? parseNonNegativeId(input.roundId, 'roundId') : tupleValue<bigint>(dispute, 4, 'lastRoundId');
    const jurorState = await client.readContract<unknown>({ address: disputeManager, abi: celesteDisputeManagerAbi, functionName: 'getJuror', args: [disputeId, roundId, juror] });
    const weight = tupleValue<bigint>(jurorState, 0, 'weight');
    const rewarded = tupleValue<boolean>(jurorState, 1, 'rewarded');
    if (weight === 0n) return fail('juror_not_drafted', `Juror ${juror} has zero weight for dispute ${disputeId.toString()} round ${roundId.toString()}.`, { disputeId: disputeId.toString(), roundId: roundId.toString(), juror }, false);
    if (rewarded) return fail('already_rewarded', `Juror ${juror} has already been rewarded for dispute ${disputeId.toString()} round ${roundId.toString()}.`, { disputeId: disputeId.toString(), roundId: roundId.toString(), juror }, false);
    const args = [disputeId, roundId, juror] as [bigint, bigint, HexAddress];
    const data = encodeFunctionData({ abi: celesteDisputeManagerAbi, functionName: 'settleReward', args });
    const preview = buildTxPreview({ chainId, from: account, to: disputeManager, data, contractName: 'CelesteDisputeManager', method: 'settleReward', args: { disputeId: disputeId.toString(), roundId: roundId.toString(), juror, weight: weight.toString() }, humanSummary: `Claim/settle Honey/Celeste juror rewards for ${juror} on dispute ${disputeId.toString()} round ${roundId.toString()}.`, risk: 'medium' });
    const simulated = await simulateDisputeManagerPreview(client, preview, 'settleReward', args, account, disputeManager);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'settleReward simulation reverted.', simulated, false);
    return ok(simulated, ['Reward settlement may assign HNY and fee-token balances according to final ruling/coherence; simulation is the source of truth before submission.']);
  } catch (error) {
    return fail('court_claim_rewards_preview_failed', error instanceof Error ? error.message : 'Failed to build Honey court reward claim preview.', undefined, true);
  }
}

function redactUrl(value: string): string {
  return value.replace(/https:\/\/gateway\.thegraph\.com\/api\/[^/\s]+/g, 'https://gateway.thegraph.com/api/[REDACTED]');
}

function envUrl(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

const DEFAULT_CELESTE_SUBGRAPH_DEPLOYMENT_ID = '0x0a0e39e376bf1e9a46c797368634bd886d15ec989039feb37a05e8448cdecb7d';
const DEFAULT_AGREEMENT_SUBGRAPH_DEPLOYMENT_ID = '0x291048c4f6e5ad955e5382a4e111ff9bce87f38ea8a1f44de76ff956d50727a5';

function graphGatewayUrl(id: string | undefined, kind: 'subgraph' | 'deployment'): string | undefined {
  if (!id) return undefined;
  const graphApiKey = envUrl('THE_GRAPH_API_KEY') ?? envUrl('GRAPH_API_KEY');
  const path = kind === 'deployment' ? 'deployments/id' : 'subgraphs/id';
  return graphApiKey ? `https://gateway.thegraph.com/api/${graphApiKey}/${path}/${id}` : undefined;
}

type ResolvedSubgraphEndpoint = { url?: string; source: NonNullable<SubgraphEndpointStatus['source']>; missingMessage?: string };

function resolveCelesteSubgraphEndpoint(input?: string): ResolvedSubgraphEndpoint {
  if (input) return { url: input, source: 'cli' };
  const envConfigured = envUrl('CELESTE_SUBGRAPH_URL') ?? envUrl('HONEY_COURT_SUBGRAPH_URL');
  if (envConfigured) return { url: envConfigured, source: 'env-url' };
  const deploymentUrl = graphGatewayUrl(envUrl('CELESTE_SUBGRAPH_DEPLOYMENT_ID') ?? envUrl('HONEY_COURT_SUBGRAPH_DEPLOYMENT_ID') ?? DEFAULT_CELESTE_SUBGRAPH_DEPLOYMENT_ID, 'deployment');
  if (deploymentUrl) return { url: deploymentUrl, source: 'graph-gateway-id' };
  const gatewayUrl = graphGatewayUrl(envUrl('CELESTE_SUBGRAPH_ID') ?? envUrl('HONEY_COURT_SUBGRAPH_ID'), 'subgraph');
  if (gatewayUrl) return { url: gatewayUrl, source: 'graph-gateway-id' };
  return { source: 'missing', missingMessage: 'THE_GRAPH_API_KEY is not configured for the built-in Celeste subgraph deployment ID. Alternatively set CELESTE_SUBGRAPH_URL for a full endpoint override.' };
}

function resolveAgreementSubgraphEndpoint(input?: string): ResolvedSubgraphEndpoint {
  if (input) return { url: input, source: 'cli' };
  const envConfigured = envUrl('AGREEMENT_SUBGRAPH_URL') ?? envUrl('ARAGON_AGREEMENT_SUBGRAPH_URL');
  if (envConfigured) return { url: envConfigured, source: 'env-url' };
  const deploymentUrl = graphGatewayUrl(envUrl('AGREEMENT_SUBGRAPH_DEPLOYMENT_ID') ?? envUrl('ARAGON_AGREEMENT_SUBGRAPH_DEPLOYMENT_ID') ?? DEFAULT_AGREEMENT_SUBGRAPH_DEPLOYMENT_ID, 'deployment');
  if (deploymentUrl) return { url: deploymentUrl, source: 'graph-gateway-id' };
  const gatewayUrl = graphGatewayUrl(envUrl('AGREEMENT_SUBGRAPH_ID') ?? envUrl('ARAGON_AGREEMENT_SUBGRAPH_ID'), 'subgraph');
  if (gatewayUrl) return { url: gatewayUrl, source: 'graph-gateway-id' };
  return { source: 'missing', missingMessage: 'THE_GRAPH_API_KEY is not configured for the built-in Agreement subgraph deployment ID. Alternatively set AGREEMENT_SUBGRAPH_URL for a full endpoint override.' };
}

function enrichTimestamp(status: SubgraphEndpointStatus, now: Date, maxIndexedAgeSeconds: number): void {
  if (!status.latestIndexedTimestamp || !/^\d+$/.test(status.latestIndexedTimestamp)) return;
  const ageSeconds = Math.max(0, Math.floor(now.getTime() / 1000) - Number(status.latestIndexedTimestamp));
  status.latestIndexedAgeSeconds = String(ageSeconds);
  status.stale = ageSeconds > maxIndexedAgeSeconds;
}

async function checkCelesteSubgraph(endpoint: ResolvedSubgraphEndpoint, graphRequest: GraphRequestFn, now: Date, maxIndexedAgeSeconds: number): Promise<SubgraphEndpointStatus> {
  if (!endpoint.url) return { name: 'celeste', urlConfigured: false, ok: false, source: endpoint.source, error: endpoint.missingMessage ?? 'Celeste subgraph endpoint is not configured.' };
  try {
    const result = await graphRequest<{ courtConfigs?: Array<{ id: string; currentTerm?: string }>; disputes?: Array<{ id: string; createdAt?: string; lastUpdate?: string; updatedAt?: string }> }>(endpoint.url, `
      query HoneyCourtSubgraphStatus {
        courtConfigs(first: 1) { id currentTerm }
        disputes(first: 1, orderBy: createdAt, orderDirection: desc) { id createdAt }
      }
    `);
    const config = result.courtConfigs?.[0];
    const dispute = result.disputes?.[0];
    const status: SubgraphEndpointStatus = { name: 'celeste', urlConfigured: true, ok: true, source: endpoint.source, redactedUrl: redactUrl(endpoint.url) };
    const fieldsAvailable: string[] = [];
    const missingFields: string[] = [];
    if (config?.currentTerm !== undefined) {
      status.indexedCurrentTerm = String(config.currentTerm);
      fieldsAvailable.push('courtConfigs.currentTerm');
    } else {
      missingFields.push('courtConfigs.currentTerm');
    }
    const latestTimestamp = dispute?.updatedAt ?? dispute?.lastUpdate ?? dispute?.createdAt;
    if (latestTimestamp !== undefined) {
      status.latestIndexedTimestamp = String(latestTimestamp);
      fieldsAvailable.push(dispute?.updatedAt !== undefined ? 'disputes.updatedAt' : dispute?.lastUpdate !== undefined ? 'disputes.lastUpdate' : 'disputes.createdAt');
    } else {
      missingFields.push('disputes.createdAt');
    }
    if (dispute?.id !== undefined) status.sampleId = String(dispute.id);
    if (fieldsAvailable.length) status.fieldsAvailable = fieldsAvailable;
    if (missingFields.length) {
      status.ok = false;
      status.missingFields = missingFields;
      status.error = `Missing expected field(s): ${missingFields.join(', ')}`;
    }
    enrichTimestamp(status, now, maxIndexedAgeSeconds);
    return status;
  } catch (error) {
    return { name: 'celeste', urlConfigured: true, ok: false, source: endpoint.source, redactedUrl: redactUrl(endpoint.url), error: redactUrl(error instanceof Error ? error.message : 'Celeste subgraph query failed.') };
  }
}

async function checkAgreementSubgraph(endpoint: ResolvedSubgraphEndpoint, graphRequest: GraphRequestFn, now: Date, maxIndexedAgeSeconds: number): Promise<SubgraphEndpointStatus> {
  if (!endpoint.url) return { name: 'agreement', urlConfigured: false, ok: false, source: endpoint.source, error: endpoint.missingMessage ?? 'Agreement subgraph endpoint is not configured.' };
  try {
    const result = await graphRequest<{ actions?: Array<{ id: string; createdAt?: string; updatedAt?: string }> }>(endpoint.url, `
      query HoneyAgreementSubgraphStatus {
        actions(first: 1, orderBy: createdAt, orderDirection: desc) { id createdAt }
      }
    `);
    const action = result.actions?.[0];
    const status: SubgraphEndpointStatus = { name: 'agreement', urlConfigured: true, ok: true, source: endpoint.source, redactedUrl: redactUrl(endpoint.url) };
    const fieldsAvailable: string[] = [];
    const missingFields: string[] = [];
    const latestTimestamp = action?.updatedAt ?? action?.createdAt;
    if (latestTimestamp !== undefined) {
      status.latestIndexedTimestamp = String(latestTimestamp);
      fieldsAvailable.push(action?.updatedAt !== undefined ? 'actions.updatedAt' : 'actions.createdAt');
    } else {
      missingFields.push('actions.createdAt');
    }
    if (action?.id !== undefined) status.sampleId = String(action.id);
    if (fieldsAvailable.length) status.fieldsAvailable = fieldsAvailable;
    if (missingFields.length) {
      status.ok = false;
      status.missingFields = missingFields;
      status.error = `Missing expected field(s): ${missingFields.join(', ')}`;
    }
    enrichTimestamp(status, now, maxIndexedAgeSeconds);
    return status;
  } catch (error) {
    return { name: 'agreement', urlConfigured: true, ok: false, source: endpoint.source, redactedUrl: redactUrl(endpoint.url), error: redactUrl(error instanceof Error ? error.message : 'Agreement subgraph query failed.') };
  }
}

export async function readCourtSubgraphStatus(input: CourtSubgraphStatusInput = {}, deps: CourtDeps = {}): Promise<OneHiveToolResult<CourtSubgraphStatusOutput>> {
  const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
  const warnings: string[] = [];
  const maxIndexedAgeSeconds = input.maxIndexedAgeSeconds ?? 86_400;
  const graphRequest = deps.graphRequest ?? request as GraphRequestFn;
  const now = deps.now ?? new Date();
  let rpcCurrentTermId: string | undefined;
  try {
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    rpcCurrentTermId = (await client.readContract<bigint>({ address: courtAddress(), abi: celesteCourtAbi, functionName: 'getCurrentTermId' })).toString();
  } catch (error) {
    warnings.push(`Failed to read RPC court term for subgraph comparison: ${error instanceof Error ? error.message : 'unknown error'}`);
  }
  const endpoints = await Promise.all([
    checkCelesteSubgraph(resolveCelesteSubgraphEndpoint(input.celesteSubgraphUrl), graphRequest, now, maxIndexedAgeSeconds),
    checkAgreementSubgraph(resolveAgreementSubgraphEndpoint(input.agreementSubgraphUrl), graphRequest, now, maxIndexedAgeSeconds)
  ]);
  const celeste = endpoints.find((endpoint) => endpoint.name === 'celeste');
  if (rpcCurrentTermId && celeste?.indexedCurrentTerm) {
    celeste.rpcCurrentTerm = rpcCurrentTermId;
    const termLag = BigInt(rpcCurrentTermId) - BigInt(celeste.indexedCurrentTerm);
    celeste.termLag = termLag > 0n ? termLag.toString() : '0';
    if (termLag > 0n) warnings.push(`Celeste subgraph currentTerm ${celeste.indexedCurrentTerm} lags RPC currentTerm ${rpcCurrentTermId} by ${termLag.toString()} term(s).`);
  }
  for (const endpoint of endpoints) {
    if (!endpoint.ok) warnings.push(`${endpoint.name} subgraph unhealthy: ${endpoint.error ?? 'unknown error'}`);
    if (endpoint.stale) warnings.push(`${endpoint.name} subgraph latest indexed timestamp ${endpoint.latestIndexedTimestamp} is older than ${maxIndexedAgeSeconds} second(s).`);
  }
  return ok({ chainId, ...(rpcCurrentTermId ? { rpcCurrentTermId } : {}), endpoints }, warnings);
}

export const courtStatusTool: ToolDefinition<CourtStatusInput, CourtStatusOutput> = {
  name: 'onehive_court_status',
  description: 'Read Honey/Celeste court term status and heartbeat requirements from RPC.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { chainId: { enum: [100, 10200, 31337] }, verifyCode: { type: 'boolean' } } },
  handler: readCourtStatus
};

export const courtHeartbeatTxTool: ToolDefinition<CourtHeartbeatTxInput, TxPreview> = {
  name: 'onehive_court_heartbeatTx',
  description: 'Build an unsigned Celeste court heartbeat(uint64) transaction preview after checking needed term transitions.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { maxTransitions: { type: 'number', minimum: 1, maximum: MAX_HEARTBEAT_TRANSITIONS }, ...commonTxFields() } },
  handler: buildCourtHeartbeatPreview
};

export const courtSubgraphStatusTool: ToolDefinition<CourtSubgraphStatusInput, CourtSubgraphStatusOutput> = {
  name: 'onehive_court_subgraphStatus',
  description: 'Check Honey/Celeste and Agreement subgraph health and compare indexed court term to RPC where possible.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { chainId: chainIdSchema, celesteSubgraphUrl: { type: 'string' }, agreementSubgraphUrl: { type: 'string' }, maxIndexedAgeSeconds: { type: 'number', minimum: 1 } } },
  handler: readCourtSubgraphStatus
};

export const courtStakeTxTool: ToolDefinition<CourtStakeTxInput, TxPreview> = {
  name: 'onehive_court_stakeTx',
  description: 'Build an unsigned Celeste registry stakeFor HNY transaction preview after allowance checks.',
  inputSchema: { type: 'object', required: ['amountHny'], additionalProperties: false, properties: { amountHny: amountStringSchema, juror: addressSchema, data: hexBytesSchema, ...commonTxFields() } },
  handler: buildCourtStakePreview
};

export const courtActivateTxTool: ToolDefinition<CourtTokenActivationTxInput, TxPreview> = {
  name: 'onehive_court_activateTx',
  description: 'Build an unsigned Celeste registry activate HNY transaction preview.',
  inputSchema: { type: 'object', required: ['amountHny'], additionalProperties: false, properties: { amountHny: amountStringSchema, ...commonTxFields() } },
  handler: (input) => buildCourtTokenActivationPreview(input, 'activate')
};

export const courtDeactivateTxTool: ToolDefinition<CourtTokenActivationTxInput, TxPreview> = {
  name: 'onehive_court_deactivateTx',
  description: 'Build an unsigned Celeste registry deactivate HNY transaction preview.',
  inputSchema: courtActivateTxTool.inputSchema,
  handler: (input) => buildCourtTokenActivationPreview(input, 'deactivate')
};

export const courtUnstakeTxTool: ToolDefinition<CourtTokenActivationTxInput, TxPreview> = {
  name: 'onehive_court_unstakeTx',
  description: 'Build an unsigned Celeste registry unstake HNY transaction preview.',
  inputSchema: courtActivateTxTool.inputSchema,
  handler: (input) => buildCourtTokenActivationPreview(input, 'unstake')
};

const courtVoteInputSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    voteId: uintIdSchema,
    disputeId: uintIdSchema,
    roundId: uintIdSchema,
    commitment: bytes32Schema,
    outcome: uintIdSchema,
    salt: bytes32Schema,
    juror: addressSchema,
    ...commonTxFields()
  }
};

export const courtCommitTxTool: ToolDefinition<CourtCommitTxInput, TxPreview> = {
  name: 'onehive_court_commitTx',
  description: 'Build an unsigned Celeste voting commit transaction preview for a keeper vote.',
  inputSchema: courtVoteInputSchema,
  handler: buildCourtCommitPreview
};

export const courtRevealTxTool: ToolDefinition<CourtRevealTxInput, TxPreview> = {
  name: 'onehive_court_revealTx',
  description: 'Build an unsigned Celeste voting reveal transaction preview for a keeper vote.',
  inputSchema: courtVoteInputSchema,
  handler: buildCourtRevealPreview
};

export const courtAppealTxTool: ToolDefinition<CourtAppealTxInput, TxPreview> = {
  name: 'onehive_court_appealTx',
  description: 'Build an unsigned Celeste dispute appeal or confirm-appeal transaction preview after fee-token allowance checks.',
  inputSchema: { type: 'object', required: ['disputeId'], additionalProperties: false, properties: { disputeId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, roundId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, outcome: { oneOf: [{ type: 'string' }, { type: 'number' }] }, ruling: { oneOf: [{ type: 'string' }, { type: 'number' }] }, confirm: { type: 'boolean' }, mode: { enum: ['create', 'confirm'] }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: buildCourtAppealPreview
};

const courtRewardsInputSchema = { type: 'object', required: ['disputeId'], additionalProperties: false, properties: { disputeId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, roundId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, juror: { type: 'string', pattern: addressPattern }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } };

export const courtRewardsTool: ToolDefinition<CourtRewardsInput, CourtRewardsOutput> = {
  name: 'onehive_court_rewards',
  description: 'Read Honey/Celeste juror reward eligibility for a dispute and optional round.',
  inputSchema: courtRewardsInputSchema,
  handler: readCourtRewards
};

export const courtClaimRewardsTxTool: ToolDefinition<CourtRewardsInput, TxPreview> = {
  name: 'onehive_court_claimRewardsTx',
  description: 'Build an unsigned Celeste settleReward transaction preview for a juror reward claim.',
  inputSchema: courtRewardsInputSchema,
  handler: buildCourtClaimRewardsPreview
};
