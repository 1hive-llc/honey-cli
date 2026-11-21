import { CELESTE, HONEYSWAP, ONEHIVE, TOKENS } from '../addresses.js';
import { celesteCourtAbi } from '../abis/celesteCourt.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { evaluateTxPolicy, type TxPolicyContext } from '../policy.js';
import type { ChainId, HexAddress, PolicyCheck, TxPreview } from '../schemas.js';

export function cloneTxPreview(tx: TxPreview): TxPreview {
  return JSON.parse(JSON.stringify(tx)) as TxPreview;
}

const LOCKED_SELECTORS_BY_ADDRESS = new Map<string, Record<string, string>>([
  [ONEHIVE.CONVICTION_VOTING.toLowerCase(), { getProposal: '0xc7f758a8', addProposal: '0x4ef4d13f', stakeToProposal: '0xfc370051', stakeAllToProposal: '0x1df67d2f', withdrawFromProposal: '0x649c649c', withdrawAllFromProposal: '0x4fb3cbbc', executeProposal: '0x0d61b519', cancelProposal: '0xe0a8f6f5' }],
  [ONEHIVE.DISPUTABLE_VOTING.toLowerCase(), { newVote: '0x0a0932da', vote: '0xc9d27afe', executeVote: '0x955131ed', getVote: '0x5a55c1f0', getSetting: '0x40b43701', getCastVote: '0x980704cf', canVote: '0xcdb2867b', canExecute: '0xcc63604a', isVoteOpenForVoting: '0x143b8f27', votesLength: '0xde4f6347', settingsLength: '0x4b4e45cf', token: '0xfc0c546a' }],
  [ONEHIVE.AGREEMENT.toLowerCase(), { sign: '0x2fb1b25f', getSigner: '0x1180b553', getAction: '0xb6e76873', getChallenge: '0x1bdd4b74', getChallengeArbitratorFees: '0xf891e0e3', getCollateralRequirement: '0x221ce7c3', canChallenge: '0x6ab6802b', canClose: '0x76740b5b', canSettle: '0xdf69433b', canClaimSettlement: '0xcd2b85db', canDispute: '0xac1b2335', challengeAction: '0x36e21a57', settleAction: '0x3e838152', disputeAction: '0x2edc71ba', submitEvidence: '0xb9e9823f', closeAction: '0x3b92da72' }],
  [CELESTE.COURT.toLowerCase(), { getCurrentTermId: '0x08135a93', getNeededTermTransitions: '0x50c36580', getTermDuration: '0x22f8f6f3', getVoting: '0x1986d376', getDisputeManager: '0xdb9bee46', heartbeat: '0x9bf6fa57' }],
  [CELESTE.REGISTRY.toLowerCase(), { stakeFor: '0x0ef96356', unstake: '0xc8fd6ed0', activate: '0xb260c42a', deactivate: '0x916b9bef', balanceOf: '0x70a08231', activeBalanceOf: '0x59f769a9' }],
  [TOKENS.HNY.toLowerCase(), { symbol: '0x95d89b41', decimals: '0x313ce567', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3', transfer: '0xa9059cbb' }],
  [TOKENS.WXDAI.toLowerCase(), { symbol: '0x95d89b41', decimals: '0x313ce567', balanceOf: '0x70a08231', allowance: '0xdd62ed3e', approve: '0x095ea7b3', transfer: '0xa9059cbb' }],
  [HONEYSWAP.ROUTER.toLowerCase(), { getAmountsOut: '0xd06ca61f', getAmountsIn: '0x1f00ca74', swapExactTokensForTokens: '0x38ed1739', swapTokensForExactTokens: '0x8803dbee' }]
]);

const CELESTE_VOTING_SELECTORS = { commit: '0xf2f03877', reveal: '0x5f38b99c', isValidOutcome: '0xe2e7ed9f', getMaxAllowedOutcome: '0x2aee0e66' } as const;
const CELESTE_DISPUTE_MANAGER_SELECTORS = { createAppeal: '0x0d03d126', confirmAppeal: '0x9c0065f7', settleReward: '0x82a8b3b0', getDispute: '0xe3a96cbd', getNextRoundDetails: '0xcd604ada', getJuror: '0x4b4acfd3' } as const;

export type SelectorVerification = {
  abiLockStatus: 'match' | 'missing' | 'mismatch';
  methodSelectorKnown: boolean;
  decodedMethodMatches: boolean;
  selector?: string;
  lockedMethod?: string;
  additionalAllowlistedTargets?: HexAddress[];
};

export type SubmitPreflightResult = {
  tx: TxPreview;
  checks: PolicyCheck[];
  selector: SelectorVerification;
  activeChainId: ChainId | number;
};

export async function simulateContractPreviewWithPolicy(input: {
  client: ChainClient;
  preview: TxPreview;
  abi: readonly unknown[];
  functionName: string;
  args: unknown[];
  account: HexAddress;
  policy?: Partial<TxPolicyContext>;
}): Promise<TxPreview> {
  const { client, preview, abi, functionName, args, account, policy } = input;
  const activeChainId = await client.getChainId();
  if (activeChainId !== preview.chainId) throw new Error(`RPC endpoint is connected to chain ${activeChainId}, requested ${preview.chainId}.`);
  const code = await client.getBytecode(preview.to);
  const simulation = await client.simulateContract({ account, address: preview.to, abi, functionName, args });
  preview.simulation = simulation.status === 'success'
    ? { status: 'success', ...(simulation.gasEstimate !== undefined ? { gasEstimate: simulation.gasEstimate.toString() } : {}) }
    : { status: 'revert', ...(simulation.revertReason !== undefined ? { revertReason: simulation.revertReason } : {}) };
  preview.policy.checks = evaluateTxPolicy(preview, {
    chainId: preview.chainId,
    allowTestnetWrites: preview.chainId !== 100,
    methodSelectorKnown: true,
    targetHasCode: Boolean(code && code !== '0x'),
    abiLockStatus: 'match',
    simulationStatus: preview.simulation.status,
    ...policy
  });
  return preview;
}

function methodForSelector(selectors: Record<string, string>, selector: string): string | undefined {
  return Object.entries(selectors).find(([, value]) => value.toLowerCase() === selector.toLowerCase())?.[0];
}

function decodedMethodMatches(tx: TxPreview, lockedMethod: string | undefined): boolean {
  if (!lockedMethod) return false;
  const expected = lockedMethod.includes('(') ? lockedMethod.slice(0, lockedMethod.indexOf('(')) : lockedMethod;
  return tx.decoded.method === expected;
}

async function lockedSelectorsForTx(client: ChainClient, tx: TxPreview): Promise<{ selectors?: Record<string, string>; additionalAllowlistedTargets?: HexAddress[] }> {
  const staticSelectors = LOCKED_SELECTORS_BY_ADDRESS.get(tx.to.toLowerCase());
  if (staticSelectors) return { selectors: staticSelectors };
  try {
    const [voting, disputeManager] = await Promise.all([
      client.readContract<HexAddress>({ address: CELESTE.COURT, abi: celesteCourtAbi, functionName: 'getVoting' }),
      client.readContract<HexAddress>({ address: CELESTE.COURT, abi: celesteCourtAbi, functionName: 'getDisputeManager' })
    ]);
    if (tx.to.toLowerCase() === voting.toLowerCase()) return { selectors: CELESTE_VOTING_SELECTORS, additionalAllowlistedTargets: [voting] };
    if (tx.to.toLowerCase() === disputeManager.toLowerCase()) return { selectors: CELESTE_DISPUTE_MANAGER_SELECTORS, additionalAllowlistedTargets: [disputeManager] };
  } catch {
    // If dynamic Celeste module lookup fails, fall through to missing ABI-lock.
  }
  return {};
}

async function verifyLockedSelector(client: ChainClient, tx: TxPreview): Promise<SelectorVerification> {
  const selector = tx.data.length >= 10 ? tx.data.slice(0, 10).toLowerCase() : undefined;
  if (!selector) return { abiLockStatus: 'missing', methodSelectorKnown: false, decodedMethodMatches: false };
  const locked = await lockedSelectorsForTx(client, tx);
  const lockedMethod = locked.selectors ? methodForSelector(locked.selectors, selector) : undefined;
  const match = decodedMethodMatches(tx, lockedMethod);
  return {
    abiLockStatus: lockedMethod ? 'match' : 'missing',
    methodSelectorKnown: Boolean(lockedMethod),
    decodedMethodMatches: match,
    selector,
    ...(lockedMethod ? { lockedMethod } : {}),
    ...(locked.additionalAllowlistedTargets ? { additionalAllowlistedTargets: locked.additionalAllowlistedTargets } : {})
  };
}

export async function preflightSubmitPreview(input: { tx: TxPreview; signerMode?: 'safe' | 'ledger' | 'dev-private-key' | 'keystore' | 'external-signer' | 'signer-daemon'; client?: ChainClient }): Promise<SubmitPreflightResult> {
  const verified = cloneTxPreview(input.tx);
  const client = input.client ?? createChainClientFromEnv(verified.chainId);
  const activeChainId = await client.getChainId();
  const bytecode = activeChainId === verified.chainId ? await client.getBytecode(verified.to) : undefined;
  const selector = activeChainId === verified.chainId ? await verifyLockedSelector(client, verified) : { abiLockStatus: 'missing' as const, methodSelectorKnown: false, decodedMethodMatches: false };
  if (activeChainId === verified.chainId) {
    try {
      if (client.call) await client.call(verified);
      const gas = await client.estimateGas(verified);
      verified.simulation = { status: 'success', gasEstimate: gas.toString() };
    } catch (error) {
      verified.simulation = { status: 'revert', revertReason: error instanceof Error ? error.message : 'eth_call or gas estimation reverted.' };
    }
  } else {
    verified.simulation = { status: 'revert', revertReason: `RPC endpoint is connected to chain ${activeChainId}, tx is for ${verified.chainId}.` };
  }
  const checks = evaluateTxPolicy(verified, {
    chainId: verified.chainId,
    allowTestnetWrites: verified.chainId !== 100,
    signerMode: input.signerMode ?? 'safe',
    targetHasCode: Boolean(bytecode && bytecode !== '0x'),
    methodSelectorKnown: selector.methodSelectorKnown,
    abiLockStatus: selector.abiLockStatus,
    simulationStatus: verified.simulation.status,
    ...(selector.additionalAllowlistedTargets ? { additionalAllowlistedTargets: selector.additionalAllowlistedTargets } : {})
  });
  if (!selector.decodedMethodMatches) {
    checks.push({ name: 'decoded-method', status: 'fail', detail: selector.lockedMethod ? `Preview decoded method ${verified.decoded.method} does not match locked selector method ${selector.lockedMethod}.` : 'Preview calldata selector is not covered by a locked ABI.' });
  } else {
    checks.push({ name: 'decoded-method', status: 'pass', detail: `Preview decoded method matches locked selector method ${selector.lockedMethod}.` });
  }
  verified.policy.checks = checks;
  return { tx: verified, checks, selector, activeChainId };
}
