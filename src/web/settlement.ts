import type { Address } from 'viem';
import { adapterAbi, coreAbi } from '../kleros-court/abis.js';
import { agreementAbi } from '../onehive/abis/agreement.js';
import type { ChainClient } from '../onehive/clients/chain.js';

// Input is the server's courtStatus result (latest linked app/action/challenge), not request data.
// The caller must use the same request-scoped pinned client for both reads.
type Link = {
  state: string; courtKind?: string; agreement?: Address; arbitrator?: Address; app?: Address; collateralRequirementId?: string;
  core?: Address | null; coreDispute?: string | null; dispute?: string | null; challenge?: string | null;
  closed?: boolean; adapterFinalised?: boolean | null; coreRuled?: boolean | null; period?: string | null;
  adapterRuling?: string | null; agreementRuling?: string | null; challengeState?: string;
};
type Amounts = { collateralToken: Address; actionCollateralRaw: string; challengeCollateralRaw: string;
  submitterFeeToken: Address; submitterFeeRaw: string; challengerFeeToken: Address; challengerFeeRaw: string };
type Receipt = {
  stage: 'unavailable' | 'before-callback' | 'awaiting-agreement' | 'agreement-resolved';
  roundCount: string | null; coreRuling: string | null; adapterRuling: string | null; appliedAgreementRuling: string | null;
  actionClosed: boolean | null; amounts: Amounts | null;
};

export async function readSettlement(client: ChainClient, link: Link): Promise<Receipt> {
  const unknown: Receipt = { stage: 'unavailable', roundCount: null, coreRuling: null, adapterRuling: null, appliedAgreementRuling: null,
    actionClosed: null, amounts: null };
  const { agreement, arbitrator, core, coreDispute, dispute, challenge, closed, challengeState, adapterFinalised, coreRuled } = link;
  if (link.courtKind !== 'configured-kleros-adapter' || !agreement || !arbitrator || !core || !coreDispute || !dispute || !challenge ||
      typeof closed !== 'boolean' || typeof adapterFinalised !== 'boolean' || coreRuled !== adapterFinalised) return unknown;
  try {
    const id = BigInt(coreDispute);
    const reverse = await client.readContract<bigint>({ address: arbitrator, abi: adapterAbi, functionName: 'agreementDisputeByCore', args: [id] });
    if (reverse !== BigInt(dispute)) return unknown;
    let stage: Receipt['stage'] = 'before-callback';
    let choice: bigint | null = null;
    if (adapterFinalised) {
      if (link.period !== 'execution') return unknown;
      [choice] = await client.readContract<readonly [bigint, boolean, boolean]>({ address: core, abi: coreAbi, functionName: 'currentRuling', args: [id] });
      if (choice < 0n || choice > 2n || String(choice + 2n) !== link.adapterRuling) return unknown;
      if (link.state === 'Resolved' && challengeState === ['Voided', 'Rejected', 'Accepted'][Number(choice)] &&
          link.agreementRuling === link.adapterRuling) stage = 'agreement-resolved';
      else if (link.state === 'Awaiting Agreement resolution' && challengeState === 'Disputed' && !closed && link.agreementRuling === null)
        stage = 'awaiting-agreement';
      else return unknown;
    } else if (link.state !== 'Active Kleros case' || closed || challengeState !== 'Disputed' || link.agreementRuling !== null || link.adapterRuling !== null) return unknown;
    // Court round count describes progression, not the cause or any particular transfer.
    let roundCount: string | null = null;
    try {
      const n = await client.readContract<bigint>({ address: core, abi: coreAbi, functionName: 'getNumberOfRounds', args: [id] });
      if (n > 0n) roundCount = n.toString();
    } catch { /* Older snapshots may omit this independent read. */ }
    const receipt: Receipt = { stage, roundCount, actionClosed: closed, coreRuling: choice?.toString() ?? null,
      adapterRuling: link.adapterRuling ?? null, appliedAgreementRuling: link.agreementRuling ?? null, amounts: null };
    if (link.app && link.collateralRequirementId !== undefined) {
      try {
        // Same recorded amounts as the CLI settlement report. These are not transfers or balances.
        const [[collateralToken, , actionRaw, challengeRaw], [submitterFeeToken, submitterRaw, challengerFeeToken, challengerRaw]] = await Promise.all([
          client.readContract<readonly [Address,bigint,bigint,bigint]>({ address: agreement, abi: agreementAbi,
            functionName: 'getCollateralRequirement', args: [link.app, BigInt(link.collateralRequirementId)] }),
          client.readContract<readonly [Address,bigint,Address,bigint]>({ address: agreement, abi: agreementAbi,
            functionName: 'getChallengeArbitratorFees', args: [BigInt(challenge)] })
        ]);
        receipt.amounts = { collateralToken, actionCollateralRaw: actionRaw.toString(), challengeCollateralRaw: challengeRaw.toString(),
          submitterFeeToken, submitterFeeRaw: submitterRaw.toString(), challengerFeeToken, challengerFeeRaw: challengerRaw.toString() };
      } catch { /* Old recordings may not include fee and collateral getters. */ }
    }
    return receipt;
  } catch { return unknown; }
}
