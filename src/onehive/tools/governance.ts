import { encodeFunctionData, stringToHex } from 'viem';
import { convictionVotingAbi } from '../abis/convictionVoting.js';
import { parseHnyAmount } from '../amounts.js';
import { ONEHIVE, addressFromEnvOrReference } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { buildTxPreview } from '../clients/tx.js';
import type { ToolDefinition } from '../tool-types.js';
import { simulateContractPreviewWithPolicy } from './tx-preflight.js';
import { addressPattern, fail, ok, uintStringPattern, type HexAddress, type HexData, type OneHiveToolResult, type TxPreview } from '../schemas.js';

export type GovernanceGetProposalInput = { proposalId: string | number; chainId?: 100 | 10200 | 31337 };
export type GovernanceAddProposalTxInput = { title: string; link: string; requestedAmountHnyOrWxDai: string; stableRequestAmount: boolean; beneficiary: HexAddress; from?: HexAddress; chainId?: 100 | 10200 | 31337 };
export type GovernanceStakeTxInput = { proposalId: string | number; amountHny?: string; all?: boolean; from?: HexAddress; chainId?: 100 | 10200 | 31337 };
export type GovernanceWithdrawTxInput = GovernanceStakeTxInput;
export type GovernanceProposalActionInput = { proposalId: string | number; from?: HexAddress; chainId?: 100 | 10200 | 31337 };

export type ConvictionProposalState = {
  proposalId: string;
  open: boolean;
  executed: boolean;
  status: 'Active' | 'Paused' | 'Cancelled' | 'Executed' | `Unknown(${number})`;
  statusCode: number;
  requestedAmount: string;
  stableRequestAmount: boolean;
  beneficiary: HexAddress;
  stakedTokens: string;
  convictionLast: string;
  blockLast: string;
  agreementActionId: string;
  submitter: HexAddress;
  threshold: string;
};

type SimulationInput = {
  client: ChainClient;
  preview: TxPreview;
  functionName: string;
  args: unknown[];
  account: HexAddress | undefined;
  warnings: string[];
};

export function convictionVotingAddress(): HexAddress {
  return addressFromEnvOrReference('ONEHIVE_CONVICTION_VOTING', 'onehive', 'convictionVoting', ONEHIVE.CONVICTION_VOTING);
}

function parseProposalId(proposalId: string | number): bigint {
  if (typeof proposalId === 'number') {
    if (!Number.isInteger(proposalId) || proposalId < 0) throw new Error('proposalId must be a non-negative integer.');
    return BigInt(proposalId);
  }
  if (!/^\d+$/.test(proposalId)) throw new Error('proposalId must be a non-negative integer string.');
  return BigInt(proposalId);
}

function optionalAccount(from?: HexAddress): HexAddress | undefined {
  return from ?? (process.env.AGENT_WALLET_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(process.env.AGENT_WALLET_ADDRESS)
    ? process.env.AGENT_WALLET_ADDRESS as HexAddress
    : undefined);
}

async function simulateAndPolicy({ client, preview, functionName, args, account }: SimulationInput): Promise<TxPreview> {
  if (!account) throw new Error('A from address or AGENT_WALLET_ADDRESS is required to simulate governance transaction previews.');
  preview.from = account;
  return simulateContractPreviewWithPolicy({ client, preview, abi: convictionVotingAbi, functionName, args, account });
}

export async function readConvictionProposal(
  input: GovernanceGetProposalInput,
  client = createChainClientFromEnv(input.chainId ?? 100)
): Promise<ConvictionProposalState> {
  const chainId = input.chainId ?? 100;
  const activeChainId = await client.getChainId();
  if (activeChainId !== chainId) throw new Error(`RPC endpoint is connected to chain ${activeChainId}, requested ${chainId}.`);

  const proposalId = parseProposalId(input.proposalId);
  const result = await client.readContract<readonly [bigint, boolean, HexAddress, bigint, bigint, bigint, bigint, number, HexAddress, bigint]>({
    address: convictionVotingAddress(),
    abi: convictionVotingAbi,
    functionName: 'getProposal',
    args: [proposalId]
  });
  const statusCode = Number(result[7]);
  const status = statusCode === 0 ? 'Active'
    : statusCode === 1 ? 'Paused'
    : statusCode === 2 ? 'Cancelled'
    : statusCode === 3 ? 'Executed'
    : `Unknown(${statusCode})` as const;
  return {
    proposalId: proposalId.toString(),
    open: statusCode === 0,
    executed: statusCode === 3,
    status,
    statusCode,
    requestedAmount: result[0].toString(),
    stableRequestAmount: result[1],
    beneficiary: result[2],
    stakedTokens: result[3].toString(),
    convictionLast: result[4].toString(),
    blockLast: result[5].toString(),
    agreementActionId: result[6].toString(),
    submitter: result[8],
    threshold: result[9].toString()
  };
}

type BuildGovernancePreviewDeps = { client?: ChainClient };

export async function buildAddProposalPreview(input: GovernanceAddProposalTxInput, deps: BuildGovernancePreviewDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const warnings: string[] = [];
  const chainId = input.chainId ?? 100;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const requestedAmount = parseHnyAmount(input.requestedAmountHnyOrWxDai);
  const args = [input.title, stringToHex(input.link), requestedAmount, input.stableRequestAmount, input.beneficiary] as const;
  const data = encodeFunctionData({ abi: convictionVotingAbi, functionName: 'addProposal', args });
  const account = optionalAccount(input.from);
  const previewInput: Parameters<typeof buildTxPreview>[0] = {
    chainId,
    to: convictionVotingAddress(),
    data,
    contractName: 'ConvictionVoting',
    method: 'addProposal',
    args: { ...input, requestedAmountWei: requestedAmount.toString() },
    humanSummary: `Create a Conviction Voting proposal titled "${input.title}" requesting ${input.requestedAmountHnyOrWxDai} token units for beneficiary ${input.beneficiary}.`,
    risk: 'high'
  };
  if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate governance transaction previews.', undefined, false);
  previewInput.from = account;
  const preview = buildTxPreview(previewInput);
  const simulated = await simulateAndPolicy({ client, preview, functionName: 'addProposal', args: [...args], account, warnings });
  if (simulated.simulation.status === 'revert') return fail('simulation_reverted', 'addProposal simulation reverted.', simulated, false);
  return ok(simulated, warnings);
}

export async function buildProposalTokenPreview(input: GovernanceStakeTxInput, kind: 'stake' | 'withdraw', deps: BuildGovernancePreviewDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const warnings: string[] = [];
  const chainId = input.chainId ?? 100;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const proposal = await readConvictionProposal({ proposalId: input.proposalId, chainId }, client);
  if (proposal.executed) return fail('proposal_executed', `Proposal ${proposal.proposalId} is already executed.`, { proposal }, false);
  if (!proposal.open && kind === 'stake') return fail('proposal_closed', `Proposal ${proposal.proposalId} is not open for staking.`, { proposal }, false);

  const proposalId = BigInt(proposal.proposalId);
  const useAll = Boolean(input.all);
  if (useAll && input.amountHny) return fail('ambiguous_amount', `${kind} accepts either all=true or amountHny, not both.`, undefined, false);
  if (!useAll && !input.amountHny) return fail('amount_required', `${kind} requires amountHny unless all is true.`, undefined, false);
  const amount = input.amountHny ? parseHnyAmount(input.amountHny) : 0n;
  const functionName = kind === 'stake'
    ? (useAll ? 'stakeAllToProposal' : 'stakeToProposal')
    : (useAll ? 'withdrawAllFromProposal' : 'withdrawFromProposal');
  const args = useAll ? [proposalId] as [bigint] : [proposalId, amount] as [bigint, bigint];
  const data = encodeFunctionData({ abi: convictionVotingAbi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const account = optionalAccount(input.from);
  const previewInput: Parameters<typeof buildTxPreview>[0] = {
    chainId,
    to: convictionVotingAddress(),
    data,
    contractName: 'ConvictionVoting',
    method: functionName,
    args: { proposalId: proposal.proposalId, all: useAll, amountHny: input.amountHny, amountWei: useAll ? undefined : amount.toString() },
    humanSummary: `${kind === 'stake' ? 'Stake to' : 'Withdraw from'} Conviction Voting proposal ${proposal.proposalId}${useAll ? ' using all available balance/stake' : ` amount ${input.amountHny} HNY`}.`,
    risk: 'medium'
  };
  if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate governance transaction previews.', undefined, false);
  previewInput.from = account;
  const preview = buildTxPreview(previewInput);
  const simulated = await simulateAndPolicy({ client, preview, functionName, args, account, warnings });
  if (simulated.simulation.status === 'revert') return fail('simulation_reverted', `${functionName} simulation reverted.`, simulated, false);
  return ok(simulated, warnings);
}

export async function buildProposalActionPreview(input: GovernanceProposalActionInput, action: 'execute' | 'cancel', deps: BuildGovernancePreviewDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const warnings: string[] = [];
  const chainId = input.chainId ?? 100;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const proposal = await readConvictionProposal({ proposalId: input.proposalId, chainId }, client);
  if (proposal.executed) return fail('proposal_executed', `Proposal ${proposal.proposalId} is already executed.`, { proposal }, false);
  if (!proposal.open) return fail('proposal_closed', `Proposal ${proposal.proposalId} is not open; refusing to build ${action} preview.`, { proposal }, false);

  const proposalId = BigInt(proposal.proposalId);
  const functionName = action === 'execute' ? 'executeProposal' : 'cancelProposal';
  const args = [proposalId] as [bigint];
  const data = encodeFunctionData({ abi: convictionVotingAbi, functionName, args });
  const account = optionalAccount(input.from);
  const previewInput: Parameters<typeof buildTxPreview>[0] = {
    chainId,
    to: convictionVotingAddress(),
    data,
    contractName: 'ConvictionVoting',
    method: functionName,
    args: { proposalId: proposal.proposalId },
    humanSummary: `${action === 'execute' ? 'Execute' : 'Cancel'} Conviction Voting proposal ${proposal.proposalId}.`,
    risk: 'high'
  };
  if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate governance transaction previews.', undefined, false);
  previewInput.from = account;
  const preview = buildTxPreview(previewInput);
  const simulated = await simulateAndPolicy({ client, preview, functionName, args, account, warnings });
  if (simulated.simulation.status === 'revert') return fail('simulation_reverted', `${functionName} simulation reverted.`, simulated, false);
  return ok(simulated, warnings);
}

export const governanceGetProposalTool: ToolDefinition<GovernanceGetProposalInput, ConvictionProposalState> = {
  name: 'onehive_governance_getProposal',
  description: 'Read a 1Hive Conviction Voting proposal by ID.',
  inputSchema: { type: 'object', required: ['proposalId'], additionalProperties: false, properties: { proposalId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, chainId: { enum: [100, 10200, 31337] } } },
  async handler(input) {
    try {
      return ok(await readConvictionProposal(input));
    } catch (error) {
      return fail('proposal_read_failed', error instanceof Error ? error.message : 'Failed to read Conviction Voting proposal.', undefined, true);
    }
  }
};

export const governanceAddProposalTxTool: ToolDefinition<GovernanceAddProposalTxInput, TxPreview> = {
  name: 'onehive_governance_addProposalTx',
  description: 'Build an unsigned Conviction Voting addProposal transaction preview.',
  inputSchema: {
    type: 'object',
    required: ['title', 'link', 'requestedAmountHnyOrWxDai', 'stableRequestAmount', 'beneficiary'],
    additionalProperties: false,
    properties: {
      title: { type: 'string', minLength: 1 },
      link: { type: 'string', minLength: 1 },
      requestedAmountHnyOrWxDai: { type: 'string', pattern: uintStringPattern },
      stableRequestAmount: { type: 'boolean' },
      beneficiary: { type: 'string', pattern: addressPattern },
      from: { type: 'string', pattern: addressPattern },
      chainId: { enum: [100, 10200, 31337] }
    }
  },
  async handler(input) {
    try { return await buildAddProposalPreview(input); }
    catch (error) { return fail('add_proposal_preview_failed', error instanceof Error ? error.message : 'Failed to build addProposal preview.', undefined, true); }
  }
};

export const governanceStakeTxTool: ToolDefinition<GovernanceStakeTxInput, TxPreview> = {
  name: 'onehive_governance_stakeTx',
  description: 'Build an unsigned stakeToProposal or stakeAllToProposal transaction preview.',
  inputSchema: { type: 'object', required: ['proposalId'], additionalProperties: false, properties: { proposalId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, amountHny: { type: 'string', pattern: uintStringPattern }, all: { type: 'boolean' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  async handler(input) {
    try { return await buildProposalTokenPreview(input, 'stake'); }
    catch (error) { return fail('stake_preview_failed', error instanceof Error ? error.message : 'Failed to build stake preview.', undefined, true); }
  }
};

export const governanceWithdrawTxTool: ToolDefinition<GovernanceWithdrawTxInput, TxPreview> = {
  name: 'onehive_governance_withdrawTx',
  description: 'Build an unsigned withdrawFromProposal or withdrawAllFromProposal transaction preview.',
  inputSchema: { type: 'object', required: ['proposalId'], additionalProperties: false, properties: { proposalId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, amountHny: { type: 'string', pattern: uintStringPattern }, all: { type: 'boolean' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  async handler(input) {
    try { return await buildProposalTokenPreview(input, 'withdraw'); }
    catch (error) { return fail('withdraw_preview_failed', error instanceof Error ? error.message : 'Failed to build withdraw preview.', undefined, true); }
  }
};

export const governanceExecuteTxTool: ToolDefinition<GovernanceProposalActionInput, TxPreview> = {
  name: 'onehive_governance_executeTx',
  description: 'Build an unsigned executeProposal transaction preview after state checks.',
  inputSchema: { type: 'object', required: ['proposalId'], additionalProperties: false, properties: { proposalId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  async handler(input) {
    try { return await buildProposalActionPreview(input, 'execute'); }
    catch (error) { return fail('execute_preview_failed', error instanceof Error ? error.message : 'Failed to build execute preview.', undefined, true); }
  }
};

export const governanceCancelTxTool: ToolDefinition<GovernanceProposalActionInput, TxPreview> = {
  name: 'onehive_governance_cancelTx',
  description: 'Build an unsigned cancelProposal transaction preview where ABI and permissions allow it.',
  inputSchema: { type: 'object', required: ['proposalId'], additionalProperties: false, properties: { proposalId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  async handler(input) {
    try { return await buildProposalActionPreview(input, 'cancel'); }
    catch (error) { return fail('cancel_preview_failed', error instanceof Error ? error.message : 'Failed to build cancel preview.', undefined, true); }
  }
};
