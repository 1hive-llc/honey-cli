import { describe, expect, it } from 'vitest';
import type { ChainClient } from '../../src/onehive/clients/chain.js';
import { readSettlement } from '../../src/web/settlement.js';

const a = '0x1111111111111111111111111111111111111111' as const;
const base = { state: 'Active Kleros case', courtKind: 'configured-kleros-adapter', core: a, app: a, arbitrator: a, agreement: a,
  challenge: '1', coreDispute: '0', dispute: '4', collateralRequirementId: '0', period: 'execution', challengeState: 'Disputed',
  closed: false, adapterFinalised: false, coreRuled: false, agreementRuling: null, adapterRuling: null };
const callback = { ...base, state: 'Awaiting Agreement resolution', coreRuled: true, adapterFinalised: true, adapterRuling: '4' };
const resolved = { ...callback, state: 'Resolved', challengeState: 'Accepted', agreementRuling: '4' };
function client(extra: Record<string, unknown> = {}) {
  const reads: Record<string, unknown> = { agreementDisputeByCore: 4n, currentRuling: [2n, false, false], ...extra };
  return { async readContract({functionName}: {functionName: string}) { if (!(functionName in reads)) throw Error(); return reads[functionName]; } } as ChainClient;
}
describe('Agreement settlement projection', () => {
  it('does not equate execution period or receipt of callback with Agreement resolution', async () => {
    expect(await readSettlement(client(), base)).toMatchObject({stage: 'before-callback', roundCount: null, coreRuling: null, amounts: null});
    expect(await readSettlement(client(), callback)).toMatchObject({stage: 'awaiting-agreement', coreRuling: '2', appliedAgreementRuling: null});
    expect(await readSettlement(client(), resolved)).toMatchObject({stage: 'agreement-resolved', actionClosed: false, appliedAgreementRuling: '4'});
  });
  it('rejects mismatched adapter, terminal outcome, and core ruling', async () => {
    for (const [c,l] of [[client({agreementDisputeByCore: 5n}), base], [client(), {...resolved, challengeState:'Rejected'}],
      [client({currentRuling:[1n,false,false]}), callback]] as const)
      expect((await readSettlement(c,l)).stage).toBe('unavailable');
  });
  it('reports only recorded raw amounts, even before callback', async () => {
    expect((await readSettlement(client({ getCollateralRequirement: [a,0n,21n,9n], getChallengeArbitratorFees: [a,3n,a,5n] }), base)).amounts)
      .toEqual({collateralToken:a,actionCollateralRaw:'21',challengeCollateralRaw:'9',submitterFeeToken:a,submitterFeeRaw:'3',challengerFeeToken:a,challengerFeeRaw:'5'});
  });
});
