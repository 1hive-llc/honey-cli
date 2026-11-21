import { encodeFunctionData, isHex, keccak256, stringToHex } from 'viem';
import { disputableVotingAbi } from '../abis/disputableVoting.js';
import { ONEHIVE, addressFromEnvOrReference } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { buildTxPreview } from '../clients/tx.js';
import type { ToolDefinition } from '../tool-types.js';
import { evaluateTxPolicy } from '../policy.js';
import { addressPattern, fail, ok, type ChainId, type HexAddress, type HexData, type OneHiveToolResult, type TxPreview } from '../schemas.js';

const DEFAULT_NOOP_EVM_SCRIPT = '0x00000001' as HexData;

type DecisionDeps = { client?: ChainClient };

export type DecisionGetVoteInput = { voteId: string | number; voter?: HexAddress; chainId?: ChainId };
export type DecisionNewVoteInput = { context: string; executionScript?: HexData; from?: HexAddress; chainId?: ChainId };
export type DecisionVoteTxInput = { voteId: string | number; supports: boolean; from?: HexAddress; chainId?: ChainId };
export type DecisionExecuteTxInput = { voteId: string | number; executionScript: HexData; from?: HexAddress; chainId?: ChainId };

export type DecisionVoteState = {
  voteId: string;
  status: 'Normal' | 'Paused' | 'Cancelled' | 'Executed' | `Unknown(${number})`;
  statusCode: number;
  yea: string;
  nay: string;
  totalPower: string;
  startDate: string;
  snapshotBlock: string;
  settingId: string;
  actionId: string;
  pausedAt: string;
  pauseDuration: string;
  quietEndingExtensionDuration: string;
  quietEndingSnapshotSupport: 'Absent' | 'Yea' | 'Nay' | `Unknown(${number})`;
  executionScriptHash: HexData;
  setting: {
    voteTime: string;
    supportRequiredPct: string;
    minAcceptQuorumPct: string;
    delegatedVotingPeriod: string;
    quietEndingPeriod: string;
    quietEndingExtension: string;
    executionDelay: string;
  };
  canExecute: boolean;
  isOpenForVoting: boolean;
  voter?: { address: HexAddress; canVote: boolean; state: 'Absent' | 'Yea' | 'Nay' | `Unknown(${number})`; caster: HexAddress };
};

export function decisionVotingAddress(): HexAddress {
  return addressFromEnvOrReference('ONEHIVE_DISPUTABLE_VOTING', 'onehive', 'disputableVoting', ONEHIVE.DISPUTABLE_VOTING);
}

function parseId(value: string | number): bigint {
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || value < 0) throw new Error('voteId must be a non-negative integer.');
    return BigInt(value);
  }
  if (!/^\d+$/.test(value)) throw new Error('voteId must be a non-negative integer string.');
  return BigInt(value);
}

function optionalAccount(from?: HexAddress): HexAddress | undefined {
  return from ?? (process.env.AGENT_WALLET_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(process.env.AGENT_WALLET_ADDRESS)
    ? process.env.AGENT_WALLET_ADDRESS as HexAddress
    : undefined);
}

function bytesInput(value: string): HexData {
  return isHex(value) ? value as HexData : stringToHex(value);
}

function voteStatus(statusCode: number): DecisionVoteState['status'] {
  return statusCode === 0 ? 'Normal' : statusCode === 1 ? 'Paused' : statusCode === 2 ? 'Cancelled' : statusCode === 3 ? 'Executed' : `Unknown(${statusCode})`;
}

function voterState(stateCode: number): 'Absent' | 'Yea' | 'Nay' | `Unknown(${number})` {
  return stateCode === 0 ? 'Absent' : stateCode === 1 ? 'Yea' : stateCode === 2 ? 'Nay' : `Unknown(${stateCode})`;
}

async function simulateAndPolicy(client: ChainClient, preview: TxPreview, functionName: string, args: unknown[], account: HexAddress): Promise<TxPreview> {
  const activeChainId = await client.getChainId();
  if (activeChainId !== preview.chainId) throw new Error(`RPC endpoint is connected to chain ${activeChainId}, requested ${preview.chainId}.`);
  const code = await client.getBytecode(preview.to);
  const simulation = await client.simulateContract({ account, address: preview.to, abi: disputableVotingAbi, functionName, args });
  preview.from = account;
  preview.simulation = simulation.status === 'success'
    ? { status: 'success', ...(simulation.gasEstimate !== undefined ? { gasEstimate: simulation.gasEstimate.toString() } : {}) }
    : { status: 'revert', ...(simulation.revertReason !== undefined ? { revertReason: simulation.revertReason } : {}) };
  preview.policy.checks = evaluateTxPolicy(preview, {
    chainId: preview.chainId,
    allowTestnetWrites: preview.chainId !== 100,
    methodSelectorKnown: true,
    targetHasCode: Boolean(code && code !== '0x'),
    abiLockStatus: 'match',
    simulationStatus: preview.simulation.status
  });
  return preview;
}

export async function readDecisionVote(input: DecisionGetVoteInput, deps: DecisionDeps = {}): Promise<OneHiveToolResult<DecisionVoteState>> {
  try {
    const chainId = input.chainId ?? 100;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const activeChainId = await client.getChainId();
    if (activeChainId !== chainId) throw new Error(`RPC endpoint is connected to chain ${activeChainId}, requested ${chainId}.`);
    const voteId = parseId(input.voteId);
    const vote = await client.readContract<readonly [bigint, bigint, bigint, bigint, bigint, number, bigint, bigint, bigint, bigint, bigint, number, HexData]>({ address: decisionVotingAddress(), abi: disputableVotingAbi, functionName: 'getVote', args: [voteId] });
    const setting = await client.readContract<readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint]>({ address: decisionVotingAddress(), abi: disputableVotingAbi, functionName: 'getSetting', args: [vote[6]] });
    const [canExecute, isOpenForVoting] = await Promise.all([
      client.readContract<boolean>({ address: decisionVotingAddress(), abi: disputableVotingAbi, functionName: 'canExecute', args: [voteId] }),
      client.readContract<boolean>({ address: decisionVotingAddress(), abi: disputableVotingAbi, functionName: 'isVoteOpenForVoting', args: [voteId] })
    ]);
    let voter: DecisionVoteState['voter'];
    if (input.voter) {
      const [canVote, cast] = await Promise.all([
        client.readContract<boolean>({ address: decisionVotingAddress(), abi: disputableVotingAbi, functionName: 'canVote', args: [voteId, input.voter] }),
        client.readContract<readonly [number, HexAddress]>({ address: decisionVotingAddress(), abi: disputableVotingAbi, functionName: 'getCastVote', args: [voteId, input.voter] })
      ]);
      voter = { address: input.voter, canVote, state: voterState(Number(cast[0])), caster: cast[1] };
    }
    return ok({
      voteId: voteId.toString(),
      status: voteStatus(Number(vote[5])),
      statusCode: Number(vote[5]),
      yea: vote[0].toString(),
      nay: vote[1].toString(),
      totalPower: vote[2].toString(),
      startDate: vote[3].toString(),
      snapshotBlock: vote[4].toString(),
      settingId: vote[6].toString(),
      actionId: vote[7].toString(),
      pausedAt: vote[8].toString(),
      pauseDuration: vote[9].toString(),
      quietEndingExtensionDuration: vote[10].toString(),
      quietEndingSnapshotSupport: voterState(Number(vote[11])),
      executionScriptHash: vote[12],
      setting: {
        voteTime: setting[0].toString(),
        supportRequiredPct: setting[1].toString(),
        minAcceptQuorumPct: setting[2].toString(),
        delegatedVotingPeriod: setting[3].toString(),
        quietEndingPeriod: setting[4].toString(),
        quietEndingExtension: setting[5].toString(),
        executionDelay: setting[6].toString()
      },
      canExecute,
      isOpenForVoting,
      ...(voter ? { voter } : {})
    });
  } catch (error) {
    return fail('decision_vote_read_failed', error instanceof Error ? error.message : 'Failed to read Decision vote.', undefined, true);
  }
}

export async function buildDecisionNewVotePreview(input: DecisionNewVoteInput, deps: DecisionDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? 100;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Decision vote creation.', undefined, false);
    const executionScript = input.executionScript ?? DEFAULT_NOOP_EVM_SCRIPT;
    const context = bytesInput(input.context);
    const args = [executionScript, context] as [HexData, HexData];
    const data = encodeFunctionData({ abi: disputableVotingAbi, functionName: 'newVote', args });
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: decisionVotingAddress(),
      data,
      contractName: 'DisputableVoting',
      method: 'newVote',
      args: { context: input.context, contextBytes: context, executionScript, executionScriptHash: keccak256(executionScript) },
      humanSummary: `Create a Decision vote with context ${input.context} and execution script ${executionScript}.`,
      risk: 'high'
    });
    const simulated = await simulateAndPolicy(client, preview, 'newVote', args, account);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'newVote simulation reverted.', simulated, false);
    return ok(simulated, ['Decision votes are Agreement-backed disputable actions; creation can lock collateral and may be challenged.']);
  } catch (error) {
    return fail('decision_new_vote_preview_failed', error instanceof Error ? error.message : 'Failed to build Decision newVote preview.', undefined, true);
  }
}

export async function buildDecisionCastVotePreview(input: DecisionVoteTxInput, deps: DecisionDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? 100;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Decision voting.', undefined, false);
    const state = await readDecisionVote({ voteId: input.voteId, voter: account, chainId }, { client });
    if (!state.ok || !state.data) return fail(state.error?.code ?? 'decision_vote_read_failed', state.error?.message ?? 'Failed to read vote.', state.error?.details, state.error?.retryable ?? true);
    if (!state.data.isOpenForVoting) return fail('vote_not_open', `Decision vote ${state.data.voteId} is not open for voting.`, { vote: state.data }, false);
    if (state.data.voter && !state.data.voter.canVote) return fail('cannot_vote', `Account ${account} cannot vote on Decision vote ${state.data.voteId}.`, { vote: state.data }, false);
    const voteId = BigInt(state.data.voteId);
    const args = [voteId, input.supports] as [bigint, boolean];
    const data = encodeFunctionData({ abi: disputableVotingAbi, functionName: 'vote', args });
    const preview = buildTxPreview({ chainId, from: account, to: decisionVotingAddress(), data, contractName: 'DisputableVoting', method: 'vote', args: { voteId: state.data.voteId, supports: input.supports }, humanSummary: `Vote ${input.supports ? 'yes' : 'no'} on Decision vote ${state.data.voteId}.`, risk: 'medium' });
    const simulated = await simulateAndPolicy(client, preview, 'vote', args, account);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'vote simulation reverted.', simulated, false);
    return ok(simulated);
  } catch (error) {
    return fail('decision_vote_preview_failed', error instanceof Error ? error.message : 'Failed to build Decision vote preview.', undefined, true);
  }
}

export async function buildDecisionExecutePreview(input: DecisionExecuteTxInput, deps: DecisionDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? 100;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Decision execution.', undefined, false);
    const state = await readDecisionVote({ voteId: input.voteId, chainId }, { client });
    if (!state.ok || !state.data) return fail(state.error?.code ?? 'decision_vote_read_failed', state.error?.message ?? 'Failed to read vote.', state.error?.details, state.error?.retryable ?? true);
    if (!state.data.canExecute) return fail('cannot_execute', `Decision vote ${state.data.voteId} is not executable.`, { vote: state.data }, false);
    const executionScriptHash = keccak256(input.executionScript);
    if (executionScriptHash.toLowerCase() !== state.data.executionScriptHash.toLowerCase()) return fail('execution_script_mismatch', 'Execution script hash does not match the Decision vote.', { expected: state.data.executionScriptHash, actual: executionScriptHash }, false);
    const voteId = BigInt(state.data.voteId);
    const args = [voteId, input.executionScript] as [bigint, HexData];
    const data = encodeFunctionData({ abi: disputableVotingAbi, functionName: 'executeVote', args });
    const preview = buildTxPreview({ chainId, from: account, to: decisionVotingAddress(), data, contractName: 'DisputableVoting', method: 'executeVote', args: { voteId: state.data.voteId, executionScript: input.executionScript, executionScriptHash }, humanSummary: `Execute Decision vote ${state.data.voteId}.`, risk: 'high' });
    const simulated = await simulateAndPolicy(client, preview, 'executeVote', args, account);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'executeVote simulation reverted.', simulated, false);
    return ok(simulated, ['Executing a Decision vote runs its stored EVM script. Review the script carefully before submitting.']);
  } catch (error) {
    return fail('decision_execute_preview_failed', error instanceof Error ? error.message : 'Failed to build Decision execute preview.', undefined, true);
  }
}

export const decisionGetVoteTool: ToolDefinition<DecisionGetVoteInput, DecisionVoteState> = {
  name: 'onehive_decision_getVote',
  description: 'Read a 1Hive Decision/Disputable Voting vote by ID.',
  inputSchema: { type: 'object', required: ['voteId'], additionalProperties: false, properties: { voteId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, voter: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => readDecisionVote(input)
};

export const decisionNewVoteTxTool: ToolDefinition<DecisionNewVoteInput, TxPreview> = {
  name: 'onehive_decision_newVoteTx',
  description: 'Build an unsigned Decision/Disputable Voting newVote transaction preview.',
  inputSchema: { type: 'object', required: ['context'], additionalProperties: false, properties: { context: { type: 'string', minLength: 1 }, executionScript: { type: 'string', pattern: '^0x[a-fA-F0-9]*$' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildDecisionNewVotePreview(input)
};

export const decisionVoteTxTool: ToolDefinition<DecisionVoteTxInput, TxPreview> = {
  name: 'onehive_decision_voteTx',
  description: 'Build an unsigned Decision/Disputable Voting vote transaction preview.',
  inputSchema: { type: 'object', required: ['voteId', 'supports'], additionalProperties: false, properties: { voteId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, supports: { type: 'boolean' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildDecisionCastVotePreview(input)
};

export const decisionExecuteTxTool: ToolDefinition<DecisionExecuteTxInput, TxPreview> = {
  name: 'onehive_decision_executeTx',
  description: 'Build an unsigned Decision/Disputable Voting executeVote transaction preview after state checks.',
  inputSchema: { type: 'object', required: ['voteId', 'executionScript'], additionalProperties: false, properties: { voteId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, executionScript: { type: 'string', pattern: '^0x[a-fA-F0-9]*$' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildDecisionExecutePreview(input)
};
