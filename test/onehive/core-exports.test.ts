import { describe, expect, it } from 'vitest';
import { getOneHiveTool, oneHiveTools } from '../../src/onehive/index.js';

describe('honey-core public seam', () => {
  it('exports the shared tool registry through the public core module', () => {
    expect(oneHiveTools.length).toBeGreaterThan(0);
    expect(getOneHiveTool('onehive_honey_proposal_forecast')?.name).toBe('onehive_honey_proposal_forecast');
    expect(getOneHiveTool('onehive_tx_submit')?.name).toBe('onehive_tx_submit');
  });
});
