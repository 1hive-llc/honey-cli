import { describe, expect, it } from 'vitest';
import { oracleUpdateCollateralRequirementsTxTool, oracleUpdateCourtFeesTxTool, oracleUpdatePriceTxTool } from '../../src/onehive/tools/oracle.js';

describe('oracle updater tools', () => {
  it('fail closed until calldata and simulation are implemented', async () => {
    const results = await Promise.all([
      oracleUpdatePriceTxTool.handler({}),
      oracleUpdateCourtFeesTxTool.handler({}),
      oracleUpdateCollateralRequirementsTxTool.handler({})
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('not_implemented');
      expect(result.data).toBeUndefined();
    }
  });
});
