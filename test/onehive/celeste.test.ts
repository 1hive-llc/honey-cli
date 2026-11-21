import { describe, expect, it } from 'vitest';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import type { ChainClient, ContractReadRequest, ContractSimulationRequest } from '../../src/onehive/clients/chain.js';
import type { HexAddress, HexData, TxPreview } from '../../src/onehive/schemas.js';
import {
  buildChallengeActionPreview,
  buildCloseActionPreview,
  buildDisputeActionPreview,
  buildSignAgreementPreview,
  buildSubmitEvidencePreview,
  readAgreementState
} from '../../src/onehive/tools/celeste.js';

const from = '0x1111111111111111111111111111111111111111' as HexAddress;
const disputable = '0x3333333333333333333333333333333333333333' as HexAddress;

type FakeOptions = {
  activeChainId?: number;
  closed?: boolean;
  lastChallengeId?: bigint;
  canChallenge?: boolean;
  canClose?: boolean;
  canSettle?: boolean;
  canClaimSettlement?: boolean;
  canDispute?: boolean;
  simulation?: { status: 'success'; gasEstimate?: bigint } | { status: 'revert'; revertReason?: string };
};

function fakeClient(options: FakeOptions = {}): ChainClient & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    chainId: 100,
    rpcUrl: 'mock://gnosis',
    async getChainId() {
      calls.push('getChainId');
      return options.activeChainId ?? 100;
    },
    async getBytecode() {
      calls.push('getBytecode');
      return '0x60016000' as HexData;
    },
    async readContract<T = unknown>(request: ContractReadRequest): Promise<T> {
      calls.push(`read:${request.functionName}`);
      if (request.functionName === 'getSigner') return [1n, true] as T;
      if (request.functionName === 'getAction') {
        return [disputable, 212n, 7n, 3n, from, options.closed ?? false, '0x1234', options.lastChallengeId ?? 9n, true] as T;
      }
      if (request.functionName === 'canChallenge') return (options.canChallenge ?? true) as T;
      if (request.functionName === 'canClose') return (options.canClose ?? true) as T;
      if (request.functionName === 'canSettle') return (options.canSettle ?? true) as T;
      if (request.functionName === 'canClaimSettlement') return (options.canClaimSettlement ?? false) as T;
      if (request.functionName === 'canDispute') return (options.canDispute ?? true) as T;
      if (request.functionName === 'getChallenge') return [1n, '0x4444444444444444444444444444444444444444', 999n, '0xabcd', 5n, 0, false, true, 77n, 0n] as T;
      if (request.functionName === 'getChallengeArbitratorFees') return [TOKENS.HNY, 10n, TOKENS.HNY, 20n] as T;
      if (request.functionName === 'getCollateralRequirement') return [TOKENS.HNY, 86400n, 100n, 25n] as T;
      throw new Error(`Unexpected read ${request.functionName}`);
    },
    async simulateContract(_request: ContractSimulationRequest) {
      calls.push('simulate');
      return options.simulation ?? { status: 'success' as const, gasEstimate: 123456n };
    },
    async estimateGas(_tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>) {
      calls.push('estimateGas');
      return 123456n;
    }
  };
}

describe('Celeste / Agreement tools', () => {
  it('reads signer, action, challenge, and collateral state', async () => {
    const result = await readAgreementState({ signer: from, actionId: 1 }, { client: fakeClient() });

    expect(result.ok).toBe(true);
    expect(result.data?.signer).toMatchObject({ address: from, lastSettingIdSigned: '1', mustSign: true });
    expect(result.data?.action).toMatchObject({ actionId: '1', disputable, collateralRequirementId: '7', canChallenge: true, canDispute: true });
    expect(result.data?.challenge).toMatchObject({ challengeId: '9', actionId: '1', state: 'Waiting', disputeId: '77' });
    expect(result.data?.collateralRequirement).toMatchObject({ collateralToken: TOKENS.HNY, challengeAmount: '25' });
    expect(result.warnings[0]).toContain('Challenging this action can lock');
  });

  it('builds and simulates sign Agreement preview', async () => {
    const result = await buildSignAgreementPreview({ settingId: 3, from }, { client: fakeClient() });

    expect(result.ok).toBe(true);
    expect(result.data?.to).toBe(ONEHIVE.AGREEMENT);
    expect(result.data?.data).toMatch(/^0x2fb1b25f/);
    expect(result.data?.simulation).toMatchObject({ status: 'success', gasEstimate: '123456' });
    expect(result.data?.policy.checks.some((check) => check.name === 'abi-lock' && check.status === 'pass')).toBe(true);
  });

  it('rejects challenge preview when action cannot be challenged', async () => {
    const client = fakeClient({ canChallenge: false });
    const result = await buildChallengeActionPreview({ actionId: 1, settlementOfferHny: '0.000000000000000001', finishedEvidence: false, context: 'ipfs://evidence', from }, { client });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cannot_challenge');
    expect(client.calls).not.toContain('simulate');
  });

  it('builds challenge preview with collateral warnings', async () => {
    const result = await buildChallengeActionPreview({ actionId: 1, settlementOfferHny: '0.000000000000000001', finishedEvidence: true, context: 'ipfs://evidence', from }, { client: fakeClient() });

    expect(result.ok).toBe(true);
    expect(result.data?.data).toMatch(/^0x36e21a57/);
    expect(result.data?.policy.risk).toBe('critical');
    expect(result.warnings.some((warning) => warning.includes('Collateral risk'))).toBe(true);
  });

  it('refuses dispute preview when state disallows it', async () => {
    const result = await buildDisputeActionPreview({ actionId: 1, submitterFinishedEvidence: false, from }, { client: fakeClient({ canDispute: false }) });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('cannot_dispute');
  });

  it('builds dispute, close, and submitEvidence previews', async () => {
    const dispute = await buildDisputeActionPreview({ actionId: 1, submitterFinishedEvidence: true, from }, { client: fakeClient() });
    const close = await buildCloseActionPreview({ actionId: 1, from }, { client: fakeClient() });
    const evidence = await buildSubmitEvidencePreview({ disputeId: 77, evidence: 'ipfs://evidence', finished: true, from }, { client: fakeClient() });

    expect(dispute.ok).toBe(true);
    expect(dispute.data?.data).toMatch(/^0x2edc71ba/);
    expect(dispute.warnings.some((warning) => warning.includes('Collateral risk'))).toBe(true);
    expect(close.ok).toBe(true);
    expect(close.data?.data).toMatch(/^0x3b92da72/);
    expect(evidence.ok).toBe(true);
    expect(evidence.data?.data).toMatch(/^0xb9e9823f/);
    expect(evidence.data?.decoded.args.evidence).toMatch(/^0x/);
  });

  it('returns structured failure when simulation reverts', async () => {
    const result = await buildSubmitEvidencePreview({ disputeId: 77, evidence: 'ipfs://evidence', finished: true, from }, {
      client: fakeClient({ simulation: { status: 'revert', revertReason: 'AGR_CANNOT_SUBMIT_EVIDENCE' } })
    });

    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('simulation_reverted');
    expect(result.error?.details).toMatchObject({ simulation: { status: 'revert', revertReason: 'AGR_CANNOT_SUBMIT_EVIDENCE' } });
  });
});
