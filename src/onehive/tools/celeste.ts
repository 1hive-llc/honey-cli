import { encodeFunctionData, stringToHex } from 'viem';
import { parseHnyAmount } from '../amounts.js';
import { agreementAbi, agreementChallengeStates } from '../abis/agreement.js';
import { ONEHIVE, addressFromEnvOrReference } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { buildTxPreview } from '../clients/tx.js';
import type { ToolDefinition } from '../tool-types.js';
import { evaluateTxPolicy } from '../policy.js';
import { addressPattern, fail, ok, uintStringPattern, type ChainId, type HexAddress, type HexData, type OneHiveToolResult, type TxPreview } from '../schemas.js';

const GNOSIS_CHAIN_ID = 100 as const;
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as HexAddress;

export type CelesteGetAgreementStateInput = { actionId?: string | number; signer?: HexAddress; disputableApp?: HexAddress; chainId?: ChainId };
export type CelesteSignAgreementTxInput = { settingId: string | number; from?: HexAddress; chainId?: ChainId };
export type CelesteChallengeActionTxInput = { actionId: string | number; settlementOfferHny: string; finishedEvidence: boolean; context: string; from?: HexAddress; chainId?: ChainId };
export type CelesteActionInput = { actionId: string | number; from?: HexAddress; chainId?: ChainId };
export type CelesteDisputeActionTxInput = { actionId: string | number; submitterFinishedEvidence: boolean; from?: HexAddress; chainId?: ChainId };
export type CelesteSubmitEvidenceTxInput = { disputeId: string | number; evidence: string; finished: boolean; from?: HexAddress; chainId?: ChainId };

type AgreementActionState = {
  actionId: string;
  disputable: HexAddress;
  disputableActionId: string;
  collateralRequirementId: string;
  settingId: string;
  submitter: HexAddress;
  closed: boolean;
  context: HexData;
  lastChallengeId: string;
  lastChallengeActive: boolean;
  canChallenge: boolean;
  canClose: boolean;
  canSettle?: boolean;
  canClaimSettlement?: boolean;
  canDispute?: boolean;
};

type AgreementChallengeState = {
  challengeId: string;
  actionId: string;
  challenger: HexAddress;
  endDate: string;
  context: HexData;
  settlementOffer: string;
  stateCode: number;
  state: 'Waiting' | 'Settled' | 'Disputed' | 'Rejected' | 'Accepted' | 'Voided' | `Unknown(${number})`;
  submitterFinishedEvidence: boolean;
  challengerFinishedEvidence: boolean;
  disputeId: string;
  ruling: string;
  submitterArbitratorFeesToken?: HexAddress;
  submitterArbitratorFeesAmount?: string;
  challengerArbitratorFeesToken?: HexAddress;
  challengerArbitratorFeesAmount?: string;
};

type CollateralRequirementState = {
  disputable: HexAddress;
  collateralRequirementId: string;
  collateralToken: HexAddress;
  challengeDuration: string;
  actionAmount: string;
  challengeAmount: string;
};

export type AgreementStateOutput = {
  signer?: { address: HexAddress; lastSettingIdSigned: string; mustSign: boolean };
  action?: AgreementActionState;
  challenge?: AgreementChallengeState;
  collateralRequirement?: CollateralRequirementState;
  collateralRiskWarnings: string[];
};

type CelesteDeps = { client?: ChainClient };

export function agreementAddress(): HexAddress {
  return addressFromEnvOrReference('ONEHIVE_AGREEMENT', 'onehive', 'agreement', ONEHIVE.AGREEMENT);
}

function optionalAccount(from?: HexAddress): HexAddress | undefined {
  return from ?? (process.env.AGENT_WALLET_ADDRESS && /^0x[a-fA-F0-9]{40}$/.test(process.env.AGENT_WALLET_ADDRESS)
    ? process.env.AGENT_WALLET_ADDRESS as HexAddress
    : undefined);
}

function parseId(id: string | number, label: string): bigint {
  if (typeof id === 'number') {
    if (!Number.isInteger(id) || id < 0) throw new Error(`${label} must be a non-negative integer.`);
    return BigInt(id);
  }
  if (!/^\d+$/.test(id)) throw new Error(`${label} must be a non-negative integer string.`);
  return BigInt(id);
}

function challengeState(code: number): AgreementChallengeState['state'] {
  return agreementChallengeStates[code] ?? `Unknown(${code})`;
}

async function assertChain(client: ChainClient, chainId: ChainId): Promise<void> {
  const active = await client.getChainId();
  if (active !== chainId) throw new Error(`RPC endpoint is connected to chain ${active}, requested ${chainId}.`);
}

async function readAction(client: ChainClient, actionId: bigint): Promise<AgreementActionState> {
  const result = await client.readContract<readonly [HexAddress, bigint, bigint, bigint, HexAddress, boolean, HexData, bigint, boolean]>({
    address: agreementAddress(), abi: agreementAbi, functionName: 'getAction', args: [actionId]
  });
  const [canChallenge, canClose] = await Promise.all([
    client.readContract<boolean>({ address: agreementAddress(), abi: agreementAbi, functionName: 'canChallenge', args: [actionId] }),
    client.readContract<boolean>({ address: agreementAddress(), abi: agreementAbi, functionName: 'canClose', args: [actionId] })
  ]);
  const action: AgreementActionState = {
    actionId: actionId.toString(),
    disputable: result[0],
    disputableActionId: result[1].toString(),
    collateralRequirementId: result[2].toString(),
    settingId: result[3].toString(),
    submitter: result[4],
    closed: result[5],
    context: result[6],
    lastChallengeId: result[7].toString(),
    lastChallengeActive: result[8],
    canChallenge,
    canClose
  };
  if (result[7] > 0n) {
    const [canSettle, canClaimSettlement, canDispute] = await Promise.all([
      client.readContract<boolean>({ address: agreementAddress(), abi: agreementAbi, functionName: 'canSettle', args: [actionId] }).catch(() => false),
      client.readContract<boolean>({ address: agreementAddress(), abi: agreementAbi, functionName: 'canClaimSettlement', args: [actionId] }).catch(() => false),
      client.readContract<boolean>({ address: agreementAddress(), abi: agreementAbi, functionName: 'canDispute', args: [actionId] }).catch(() => false)
    ]);
    action.canSettle = canSettle;
    action.canClaimSettlement = canClaimSettlement;
    action.canDispute = canDispute;
  }
  return action;
}

async function readChallenge(client: ChainClient, challengeId: bigint): Promise<AgreementChallengeState> {
  const result = await client.readContract<readonly [bigint, HexAddress, bigint, HexData, bigint, number, boolean, boolean, bigint, bigint]>({
    address: agreementAddress(), abi: agreementAbi, functionName: 'getChallenge', args: [challengeId]
  });
  const challenge: AgreementChallengeState = {
    challengeId: challengeId.toString(),
    actionId: result[0].toString(),
    challenger: result[1],
    endDate: result[2].toString(),
    context: result[3],
    settlementOffer: result[4].toString(),
    stateCode: Number(result[5]),
    state: challengeState(Number(result[5])),
    submitterFinishedEvidence: result[6],
    challengerFinishedEvidence: result[7],
    disputeId: result[8].toString(),
    ruling: result[9].toString()
  };
  const fees = await client.readContract<readonly [HexAddress, bigint, HexAddress, bigint]>({
    address: agreementAddress(), abi: agreementAbi, functionName: 'getChallengeArbitratorFees', args: [challengeId]
  }).catch(() => undefined);
  if (fees) {
    challenge.submitterArbitratorFeesToken = fees[0];
    challenge.submitterArbitratorFeesAmount = fees[1].toString();
    challenge.challengerArbitratorFeesToken = fees[2];
    challenge.challengerArbitratorFeesAmount = fees[3].toString();
  }
  return challenge;
}

async function readCollateral(client: ChainClient, disputable: HexAddress, collateralRequirementId: bigint): Promise<CollateralRequirementState> {
  const result = await client.readContract<readonly [HexAddress, bigint, bigint, bigint]>({
    address: agreementAddress(), abi: agreementAbi, functionName: 'getCollateralRequirement', args: [disputable, collateralRequirementId]
  });
  return {
    disputable,
    collateralRequirementId: collateralRequirementId.toString(),
    collateralToken: result[0],
    challengeDuration: result[1].toString(),
    actionAmount: result[2].toString(),
    challengeAmount: result[3].toString()
  };
}

export async function readAgreementState(input: CelesteGetAgreementStateInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<AgreementStateOutput>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    await assertChain(client, chainId);
    const out: AgreementStateOutput = { collateralRiskWarnings: [] };
    if (input.signer) {
      const signer = await client.readContract<readonly [bigint, boolean]>({ address: agreementAddress(), abi: agreementAbi, functionName: 'getSigner', args: [input.signer] });
      out.signer = { address: input.signer, lastSettingIdSigned: signer[0].toString(), mustSign: signer[1] };
    }
    if (input.actionId !== undefined) {
      const actionId = parseId(input.actionId, 'actionId');
      const action = await readAction(client, actionId);
      out.action = action;
      if (action.disputable.toLowerCase() !== ZERO_ADDRESS.toLowerCase()) {
        out.collateralRequirement = await readCollateral(client, action.disputable, BigInt(action.collateralRequirementId));
        out.collateralRiskWarnings.push(`Challenging this action can lock challenger collateral amount ${out.collateralRequirement.challengeAmount} of token ${out.collateralRequirement.collateralToken}.`);
      }
      if (BigInt(action.lastChallengeId) > 0n) out.challenge = await readChallenge(client, BigInt(action.lastChallengeId));
    } else if (input.disputableApp) {
      out.collateralRiskWarnings.push(`Provide an actionId to resolve the active collateral requirement for disputable app ${input.disputableApp}.`);
    }
    return ok(out, out.collateralRiskWarnings);
  } catch (error) {
    return fail('agreement_state_failed', error instanceof Error ? error.message : 'Failed to read Agreement state.', undefined, true);
  }
}

async function simulateAndPolicy(client: ChainClient, preview: TxPreview, functionName: string, args: unknown[], account: HexAddress): Promise<TxPreview> {
  await assertChain(client, preview.chainId);
  const code = await client.getBytecode(preview.to);
  const simulation = await client.simulateContract({ account, address: preview.to, abi: agreementAbi, functionName, args });
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

async function buildAgreementPreview(input: { chainId?: ChainId | undefined; from?: HexAddress | undefined; method: string; args: unknown[]; decodedArgs: Record<string, unknown>; summary: string; risk?: TxPreview['policy']['risk'] | undefined }, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  try {
    const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
    const client = deps.client ?? createChainClientFromEnv(chainId);
    const account = optionalAccount(input.from);
    if (!account) return fail('from_required', 'A from address or AGENT_WALLET_ADDRESS is required to simulate Agreement transaction previews.', undefined, false);
    const data = encodeFunctionData({ abi: agreementAbi, functionName: input.method, args: input.args } as Parameters<typeof encodeFunctionData>[0]);
    const preview = buildTxPreview({
      chainId,
      from: account,
      to: agreementAddress(),
      data,
      contractName: 'Agreement',
      method: input.method,
      args: input.decodedArgs,
      humanSummary: input.summary,
      risk: input.risk ?? 'high'
    });
    const simulated = await simulateAndPolicy(client, preview, input.method, input.args, account);
    if (simulated.simulation.status === 'revert') return fail('simulation_reverted', `${input.method} simulation reverted.`, simulated, false);
    return ok(simulated);
  } catch (error) {
    return fail('agreement_preview_failed', error instanceof Error ? error.message : 'Failed to build Agreement preview.', undefined, true);
  }
}

export async function buildSignAgreementPreview(input: CelesteSignAgreementTxInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const settingId = parseId(input.settingId, 'settingId');
  return buildAgreementPreview({ chainId: input.chainId, from: input.from, method: 'sign', args: [settingId], decodedArgs: { settingId: settingId.toString() }, summary: `Sign 1Hive Agreement setting ${settingId}.`, risk: 'medium' }, deps);
}

export async function buildChallengeActionPreview(input: CelesteChallengeActionTxInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const actionId = parseId(input.actionId, 'actionId');
  const action = await readAction(client, actionId);
  if (!action.canChallenge) return fail('cannot_challenge', `Agreement action ${actionId} cannot be challenged.`, { action }, false);
  const collateral = await readCollateral(client, action.disputable, BigInt(action.collateralRequirementId));
  const settlementOffer = parseHnyAmount(input.settlementOfferHny);
  if (settlementOffer > BigInt(collateral.actionAmount)) return fail('settlement_offer_too_high', 'Settlement offer exceeds the action collateral amount.', { action, collateral, settlementOffer: settlementOffer.toString() }, false);
  const context = stringToHex(input.context);
  const result = await buildAgreementPreview({ chainId, from: input.from, method: 'challengeAction', args: [actionId, settlementOffer, input.finishedEvidence, context], decodedArgs: { actionId: actionId.toString(), settlementOffer: settlementOffer.toString(), finishedEvidence: input.finishedEvidence, context }, summary: `Challenge Agreement action ${actionId}. This can lock challenger collateral and may lead to Celeste dispute costs.`, risk: 'critical' }, { client });
  if (result.ok) result.warnings.push(`Collateral risk: challenge can lock ${collateral.challengeAmount} of token ${collateral.collateralToken}; settlement offer ${settlementOffer}.`);
  return result;
}

export async function buildSettleActionPreview(input: CelesteActionInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const actionId = parseId(input.actionId, 'actionId');
  const action = await readAction(client, actionId);
  if (!action.canSettle && !action.canClaimSettlement) return fail('cannot_settle', `Agreement action ${actionId} cannot be settled.`, { action }, false);
  return buildAgreementPreview({ chainId, from: input.from, method: 'settleAction', args: [actionId], decodedArgs: { actionId: actionId.toString() }, summary: `Settle Agreement action ${actionId}.`, risk: 'high' }, { client });
}

export async function buildDisputeActionPreview(input: CelesteDisputeActionTxInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const actionId = parseId(input.actionId, 'actionId');
  const action = await readAction(client, actionId);
  if (!action.canDispute) return fail('cannot_dispute', `Agreement action ${actionId} cannot be disputed.`, { action }, false);
  const result = await buildAgreementPreview({ chainId, from: input.from, method: 'disputeAction', args: [actionId, input.submitterFinishedEvidence], decodedArgs: { actionId: actionId.toString(), submitterFinishedEvidence: input.submitterFinishedEvidence }, summary: `Dispute Agreement action ${actionId}. This is a collateral-risking Celeste action and may pay arbitrator fees.`, risk: 'critical' }, { client });
  if (result.ok) result.warnings.push('Collateral risk: disputing can escalate to Celeste arbitration and may risk arbitration fees/collateral depending on the ruling.');
  return result;
}

export async function buildSubmitEvidencePreview(input: CelesteSubmitEvidenceTxInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const disputeId = parseId(input.disputeId, 'disputeId');
  const evidence = stringToHex(input.evidence);
  return buildAgreementPreview({ chainId: input.chainId, from: input.from, method: 'submitEvidence', args: [disputeId, evidence, input.finished], decodedArgs: { disputeId: disputeId.toString(), evidence, finished: input.finished }, summary: `Submit evidence for Celeste dispute ${disputeId}; preview the evidence bytes/URI before signing.`, risk: 'high' }, deps);
}

export async function buildCloseActionPreview(input: CelesteActionInput, deps: CelesteDeps = {}): Promise<OneHiveToolResult<TxPreview>> {
  const chainId = input.chainId ?? GNOSIS_CHAIN_ID;
  const client = deps.client ?? createChainClientFromEnv(chainId);
  const actionId = parseId(input.actionId, 'actionId');
  const action = await readAction(client, actionId);
  if (!action.canClose) return fail('cannot_close', `Agreement action ${actionId} cannot be closed.`, { action }, false);
  return buildAgreementPreview({ chainId, from: input.from, method: 'closeAction', args: [actionId], decodedArgs: { actionId: actionId.toString() }, summary: `Close Agreement action ${actionId}.`, risk: 'medium' }, { client });
}

export const celesteGetAgreementStateTool: ToolDefinition<CelesteGetAgreementStateInput, AgreementStateOutput> = {
  name: 'onehive_celeste_getAgreementState',
  description: 'Read 1Hive Agreement/Celeste signer, action, challenge, and collateral state.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { actionId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, signer: { type: 'string', pattern: addressPattern }, disputableApp: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => readAgreementState(input)
};

export const celesteSignAgreementTxTool: ToolDefinition<CelesteSignAgreementTxInput, TxPreview> = {
  name: 'onehive_celeste_signAgreementTx',
  description: 'Build an unsigned Agreement sign(settingId) transaction preview.',
  inputSchema: { type: 'object', required: ['settingId'], additionalProperties: false, properties: { settingId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildSignAgreementPreview(input)
};

export const celesteChallengeActionTxTool: ToolDefinition<CelesteChallengeActionTxInput, TxPreview> = {
  name: 'onehive_celeste_challengeActionTx',
  description: 'Build an unsigned Agreement challengeAction transaction preview with collateral-risk warnings.',
  inputSchema: { type: 'object', required: ['actionId', 'settlementOfferHny', 'finishedEvidence', 'context'], additionalProperties: false, properties: { actionId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, settlementOfferHny: { type: 'string', pattern: uintStringPattern }, finishedEvidence: { type: 'boolean' }, context: { type: 'string', minLength: 1 }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildChallengeActionPreview(input)
};

export const celesteSettleActionTxTool: ToolDefinition<CelesteActionInput, TxPreview> = {
  name: 'onehive_celeste_settleActionTx',
  description: 'Build an unsigned Agreement settleAction transaction preview when state allows.',
  inputSchema: { type: 'object', required: ['actionId'], additionalProperties: false, properties: { actionId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildSettleActionPreview(input)
};

export const celesteDisputeActionTxTool: ToolDefinition<CelesteDisputeActionTxInput, TxPreview> = {
  name: 'onehive_celeste_disputeActionTx',
  description: 'Build an unsigned Agreement disputeAction transaction preview when state allows.',
  inputSchema: { type: 'object', required: ['actionId', 'submitterFinishedEvidence'], additionalProperties: false, properties: { actionId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, submitterFinishedEvidence: { type: 'boolean' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildDisputeActionPreview(input)
};

export const celesteSubmitEvidenceTxTool: ToolDefinition<CelesteSubmitEvidenceTxInput, TxPreview> = {
  name: 'onehive_celeste_submitEvidenceTx',
  description: 'Build an unsigned Agreement submitEvidence transaction preview.',
  inputSchema: { type: 'object', required: ['disputeId', 'evidence', 'finished'], additionalProperties: false, properties: { disputeId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, evidence: { type: 'string', minLength: 1 }, finished: { type: 'boolean' }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildSubmitEvidencePreview(input)
};

export const celesteCloseActionTxTool: ToolDefinition<CelesteActionInput, TxPreview> = {
  name: 'onehive_celeste_closeActionTx',
  description: 'Build an unsigned Agreement closeAction transaction preview when state allows.',
  inputSchema: { type: 'object', required: ['actionId'], additionalProperties: false, properties: { actionId: { oneOf: [{ type: 'string' }, { type: 'number' }] }, from: { type: 'string', pattern: addressPattern }, chainId: { enum: [100, 10200, 31337] } } },
  handler: (input) => buildCloseActionPreview(input)
};
