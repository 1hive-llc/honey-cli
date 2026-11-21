import { agreementCourtStatusTool } from './tools/agreement-court.js';
import { klerosStatusTool, klerosAdapterStatusTool, klerosStakeTool } from './tools/kleros.js';
import type { ToolDefinition } from './tool-types.js';
import { contextResolveTool } from './tools/context.js';
import { gardenListTool, gardenProposalsTool, gardenUserTool } from './tools/garden.js';
import {
  governanceAddProposalTxTool,
  governanceCancelTxTool,
  governanceExecuteTxTool,
  governanceGetProposalTool,
  governanceStakeTxTool,
  governanceWithdrawTxTool
} from './tools/governance.js';
import { decisionExecuteTxTool, decisionGetVoteTool, decisionNewVoteTxTool, decisionVoteTxTool } from './tools/decision.js';
import {
  celesteChallengeActionTxTool,
  celesteCloseActionTxTool,
  celesteDisputeActionTxTool,
  celesteGetAgreementStateTool,
  celesteSettleActionTxTool,
  celesteSignAgreementTxTool,
  celesteSubmitEvidenceTxTool
} from './tools/celeste.js';
import { honeyApproveTxTool, honeyQuoteTool, honeySwapTxTool } from './tools/honey.js';
import { honeyProposalForecastTool, honeyProposalsListTool } from './tools/honey-proposals.js';
import {
  oracleStatusTool,
  oracleUpdateCollateralRequirementsTxTool,
  oracleUpdateCourtFeesTxTool,
  oracleUpdatePriceTxTool
} from './tools/oracle.js';
import { txSimulateTool, txSubmitTool } from './tools/tx-submit.js';
import {
  courtActivateTxTool,
  courtAppealTxTool,
  courtClaimRewardsTxTool,
  courtCommitTxTool,
  courtDeactivateTxTool,
  courtHeartbeatTxTool,
  courtRevealTxTool,
  courtRewardsTool,
  courtStakeTxTool,
  courtStatusTool,
  courtSubgraphStatusTool,
  courtUnstakeTxTool
} from './tools/court.js';

/**
 * Neutral 1Hive/Honey tool catalog shared by the Pi extension adapter and the
 * Honey CLI. Keep Pi UI registration concerns out of this module so the CLI can
 * later move to a separate `honey-cli` repository while `bee` remains the Pi
 * package/integration layer.
 */
export const oneHiveTools: ToolDefinition<unknown, unknown>[] = [
  contextResolveTool,
  klerosStatusTool,
  klerosAdapterStatusTool,
  klerosStakeTool,
  gardenListTool,
  gardenProposalsTool,
  gardenUserTool,
  honeyProposalsListTool,
  honeyProposalForecastTool,
  governanceGetProposalTool,
  governanceAddProposalTxTool,
  governanceStakeTxTool,
  governanceWithdrawTxTool,
  governanceExecuteTxTool,
  governanceCancelTxTool,
  decisionGetVoteTool,
  decisionNewVoteTxTool,
  decisionVoteTxTool,
  decisionExecuteTxTool,
  celesteGetAgreementStateTool,
  agreementCourtStatusTool,
  celesteSignAgreementTxTool,
  celesteChallengeActionTxTool,
  celesteSettleActionTxTool,
  celesteDisputeActionTxTool,
  celesteSubmitEvidenceTxTool,
  celesteCloseActionTxTool,
  honeyQuoteTool,
  honeyApproveTxTool,
  honeySwapTxTool,
  oracleStatusTool,
  oracleUpdatePriceTxTool,
  oracleUpdateCourtFeesTxTool,
  oracleUpdateCollateralRequirementsTxTool,
  courtStatusTool,
  courtHeartbeatTxTool,
  courtSubgraphStatusTool,
  courtStakeTxTool,
  courtActivateTxTool,
  courtDeactivateTxTool,
  courtUnstakeTxTool,
  courtCommitTxTool,
  courtRevealTxTool,
  courtAppealTxTool,
  courtRewardsTool,
  courtClaimRewardsTxTool,
  txSimulateTool,
  txSubmitTool
];

export function getOneHiveTool(name: string): ToolDefinition<unknown, unknown> | undefined {
  return oneHiveTools.find((tool) => tool.name === name);
}
