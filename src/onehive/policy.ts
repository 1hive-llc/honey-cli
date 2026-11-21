import { isAllowlistedWriteTarget } from './addresses.js';
import type { ChainId, HexAddress, PolicyCheck, TxPreview } from './schemas.js';

export type TxPolicyContext = {
  chainId: ChainId;
  allowTestnetWrites?: boolean;
  quoteCreatedAtMs?: number;
  nowMs?: number;
  quoteTtlMs?: number;
  methodSelectorKnown?: boolean;
  targetHasCode?: boolean;
  unlimitedApproval?: boolean;
  unlimitedApprovalPhraseMatched?: boolean;
  signerMode?: 'safe' | 'ledger' | 'dev-private-key' | 'keystore' | 'external-signer' | 'signer-daemon';
  priceImpactBps?: number;
  priceImpactHardCapBps?: number;
  slippageBps?: number;
  slippageHardCapBps?: number;
  simulationStatus?: 'success' | 'revert' | 'not-run';
  abiLockStatus?: 'match' | 'missing' | 'mismatch';
  additionalAllowlistedTargets?: Iterable<HexAddress>;
};

export function isHexAddress(value: string): value is HexAddress {
  return /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function isMainnetChain(chainId: ChainId): boolean {
  return chainId === 100;
}

export function isLocalForkChain(chainId: ChainId): boolean {
  return chainId === 31337;
}

export function canUseDevPrivateKey(chainId: ChainId): boolean {
  return isLocalForkChain(chainId);
}

export function shortAddress(address: HexAddress): string {
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

export function generateConfirmationPhrase(tx: Pick<TxPreview, 'decoded' | 'to' | 'value'>): string {
  return `SUBMIT ${tx.decoded.method} ON GNOSIS TO ${tx.decoded.contractName} ${shortAddress(tx.to)} VALUE ${tx.value}`;
}

export function detectLikelySecret(text: string): string[] {
  const findings: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ['private key', /(?:private[_-]?key|PRIVATE_KEY)\s*[=:]\s*['\"]?0x[a-fA-F0-9]{64}/],
    ['mnemonic', /(?:mnemonic|seed phrase|SEED_PHRASE)\s*[=:]/i],
    ['github token', /gh[pousr]_[A-Za-z0-9_]{20,}/],
    ['generic api key', /(?:api[_-]?key|API_KEY|secret|SECRET)\s*[=:]\s*['\"]?[A-Za-z0-9_\-]{20,}/]
  ];
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) findings.push(label);
  }
  return findings;
}

export function evaluateTxPolicy(tx: Pick<TxPreview, 'chainId' | 'to' | 'simulation'>, context: TxPolicyContext): PolicyCheck[] {
  const nowMs = context.nowMs ?? Date.now();
  const quoteTtlMs = context.quoteTtlMs ?? 60_000;
  const impactCap = context.priceImpactHardCapBps ?? 500;
  const checks: PolicyCheck[] = [];

  checks.push({
    name: 'chain',
    status: tx.chainId === 100 || Boolean(context.allowTestnetWrites) ? 'pass' : 'fail',
    detail: tx.chainId === 100 ? 'Gnosis Chain mainnet.' : `Chain ${tx.chainId} requires explicit test/fork mode.`
  });

  const targetAllowlisted = isAllowlistedWriteTarget(tx.to, context.additionalAllowlistedTargets);
  checks.push({
    name: 'allowlisted-target',
    status: targetAllowlisted ? 'pass' : 'fail',
    detail: targetAllowlisted ? 'Target is allowlisted.' : `Target ${tx.to} is not allowlisted.`
  });

  checks.push({
    name: 'target-bytecode',
    status: context.targetHasCode === false ? 'fail' : 'pass',
    detail: context.targetHasCode === false ? 'Target has no bytecode.' : 'Target bytecode present or not checked by this policy call.'
  });

  checks.push({
    name: 'selector-known',
    status: context.methodSelectorKnown === false ? 'fail' : 'pass',
    detail: context.methodSelectorKnown === false ? 'Method selector is unknown.' : 'Method selector is known or not checked by this policy call.'
  });

  if (context.abiLockStatus) {
    checks.push({
      name: 'abi-lock',
      status: context.abiLockStatus === 'match' ? 'pass' : 'fail',
      detail: context.abiLockStatus === 'match' ? 'ABI lock matches reviewed metadata.' : `ABI lock ${context.abiLockStatus}.`
    });
  }

  checks.push({
    name: 'simulation',
    status: tx.simulation.status === 'revert' || context.simulationStatus === 'revert' ? 'fail' : tx.simulation.status === 'not-run' ? 'warn' : 'pass',
    detail: tx.simulation.status === 'success' ? 'Simulation succeeded.' : tx.simulation.status === 'revert' ? 'Simulation reverted.' : 'Simulation has not run yet.'
  });

  if (typeof context.quoteCreatedAtMs === 'number') {
    const ageMs = nowMs - context.quoteCreatedAtMs;
    checks.push({
      name: 'quote-freshness',
      status: ageMs <= quoteTtlMs ? 'pass' : 'fail',
      detail: `Quote age ${ageMs}ms; TTL ${quoteTtlMs}ms.`
    });
  }

  if (typeof context.priceImpactBps === 'number') {
    checks.push({
      name: 'price-impact',
      status: context.priceImpactBps <= impactCap ? 'pass' : 'fail',
      detail: `Price impact ${context.priceImpactBps} bps; hard cap ${impactCap} bps.`
    });
  }

  if (typeof context.slippageBps === 'number') {
    const slippageCap = context.slippageHardCapBps ?? 500;
    checks.push({
      name: 'slippage',
      status: context.slippageBps <= slippageCap ? 'pass' : 'fail',
      detail: `Slippage ${context.slippageBps} bps; hard cap ${slippageCap} bps.`
    });
  }

  if (context.unlimitedApproval) {
    checks.push({
      name: 'unlimited-approval',
      status: context.unlimitedApprovalPhraseMatched ? 'warn' : 'fail',
      detail: context.unlimitedApprovalPhraseMatched ? 'Unlimited approval was explicitly confirmed.' : 'Unlimited approval requires exact confirmation phrase.'
    });
  }

  if (!canUseDevPrivateKey(context.chainId) && context.signerMode === 'dev-private-key') {
    checks.push({
      name: 'signer-mode',
      status: 'fail',
      detail: 'dev-private-key signer mode is blocked on Gnosis mainnet.'
    });
  }

  return checks;
}

export function hasFailedPolicy(checks: PolicyCheck[]): boolean {
  return checks.some((check) => check.status === 'fail');
}
