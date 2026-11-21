import type { ToolDefinition } from '../tool-types.js';
import { notImplemented, type TxPreview } from '../schemas.js';

export const oracleStatusTool: ToolDefinition<Record<string, never>, Record<string, unknown>> = {
  name: 'onehive_oracle_status',
  description: 'Read 1Hive Honey price, court fee, and collateral updater status.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler() { return notImplemented('onehive_oracle_status'); }
};

export const oracleUpdatePriceTxTool: ToolDefinition<Record<string, never>, TxPreview> = {
  name: 'onehive_oracle_updatePriceTx',
  description: 'Build an unsigned Honey price oracle update() transaction preview.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler() {
    return notImplemented('onehive_oracle_updatePriceTx');
  }
};

export const oracleUpdateCourtFeesTxTool: ToolDefinition<Record<string, never>, TxPreview> = {
  name: 'onehive_oracle_updateCourtFeesTx',
  description: 'Build an unsigned Celeste court fees updater transaction preview.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler() {
    return notImplemented('onehive_oracle_updateCourtFeesTx');
  }
};

export const oracleUpdateCollateralRequirementsTxTool: ToolDefinition<Record<string, never>, TxPreview> = {
  name: 'onehive_oracle_updateCollateralRequirementsTx',
  description: 'Build an unsigned Agreement collateral requirements updater transaction preview.',
  inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  async handler() {
    return notImplemented('onehive_oracle_updateCollateralRequirementsTx');
  }
};
