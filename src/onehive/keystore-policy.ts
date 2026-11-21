import { readFile } from 'node:fs/promises';
import { CELESTE, ONEHIVE } from './addresses.js';
import { getKeystoreDir } from './keystore.js';
import type { ChainId, HexAddress, PolicyCheck, TxPreview } from './schemas.js';

export type KeystorePolicyPreset = 'safe-automation' | 'full-governance' | 'full-access';

export type KeystorePolicyAccount = {
  label?: string;
  address: HexAddress;
  allowedChainIds: ChainId[];
  allowedTargets?: HexAddress[];
  allowedSelectors?: string[];
  allowedMethods?: string[];
  maxValueWei?: string;
  maxRisk?: TxPreview['policy']['risk'];
};

export type KeystorePolicyFile = {
  version: 1;
  accounts: KeystorePolicyAccount[];
};

const RISK_ORDER: Record<TxPreview['policy']['risk'], number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const SAFE_AUTOMATION_METHODS = [
  'stakeToProposal',
  'stakeAllToProposal',
  'withdrawFromProposal',
  'withdrawAllFromProposal',
  'heartbeat',
  'ConvictionVoting.stakeToProposal',
  'ConvictionVoting.stakeAllToProposal',
  'ConvictionVoting.withdrawFromProposal',
  'ConvictionVoting.withdrawAllFromProposal',
  'CelesteCourt.heartbeat'
] as const;

export const SAFE_AUTOMATION_SELECTORS = [
  '0xfc370051', // stakeToProposal(uint256,uint256)
  '0x1df67d2f', // stakeAllToProposal(uint256)
  '0x649c649c', // withdrawFromProposal(uint256,uint256)
  '0x4fb3cbbc', // withdrawAllFromProposal(uint256)
  '0x9bf6fa57' // heartbeat(uint64)
] as const;

export const FULL_GOVERNANCE_METHODS = [
  'addProposal', 'stakeToProposal', 'stakeAllToProposal', 'withdrawFromProposal', 'withdrawAllFromProposal', 'executeProposal', 'cancelProposal',
  'newVote', 'vote', 'executeVote',
  'sign', 'challengeAction', 'settleAction', 'disputeAction', 'submitEvidence', 'closeAction',
  'heartbeat', 'stakeFor', 'activate', 'deactivate', 'unstake',
  'commit', 'reveal', 'createAppeal', 'confirmAppeal', 'settleReward',
  'ConvictionVoting.addProposal', 'ConvictionVoting.stakeToProposal', 'ConvictionVoting.stakeAllToProposal', 'ConvictionVoting.withdrawFromProposal', 'ConvictionVoting.withdrawAllFromProposal', 'ConvictionVoting.executeProposal', 'ConvictionVoting.cancelProposal',
  'DisputableVoting.newVote', 'DisputableVoting.vote', 'DisputableVoting.executeVote',
  'Agreement.sign', 'Agreement.challengeAction', 'Agreement.settleAction', 'Agreement.disputeAction', 'Agreement.submitEvidence', 'Agreement.closeAction',
  'CelesteCourt.heartbeat', 'CelesteJurorsRegistry.stakeFor', 'CelesteJurorsRegistry.activate', 'CelesteJurorsRegistry.deactivate', 'CelesteJurorsRegistry.unstake',
  'CelesteVoting.commit', 'CelesteVoting.reveal', 'CelesteDisputeManager.createAppeal', 'CelesteDisputeManager.confirmAppeal', 'CelesteDisputeManager.settleReward'
] as const;

export const FULL_GOVERNANCE_SELECTORS = [
  '0x4ef4d13f', '0xfc370051', '0x1df67d2f', '0x649c649c', '0x4fb3cbbc', '0x0d61b519', '0xe0a8f6f5',
  '0x0a0932da', '0xc9d27afe', '0x955131ed',
  '0x2fb1b25f', '0x36e21a57', '0x3e838152', '0x2edc71ba', '0xb9e9823f', '0x3b92da72',
  '0x9bf6fa57', '0x0ef96356', '0xb260c42a', '0x916b9bef', '0xc8fd6ed0',
  '0xf2f03877', '0x5f38b99c', '0x0d03d126', '0x9c0065f7', '0x82a8b3b0'
] as const;

export function buildKeystorePolicyPreset(input: { address: HexAddress; label?: string; chainIds?: ChainId[]; preset?: KeystorePolicyPreset } | HexAddress): KeystorePolicyFile {
  const address = typeof input === 'string' ? input : input.address;
  const label = typeof input === 'string' ? undefined : input.label;
  const preset = typeof input === 'string' ? 'safe-automation' : input.preset ?? 'safe-automation';
  const allowedChainIds = typeof input === 'string' ? [100 as const] : input.chainIds ?? [100 as const];
  const base = { ...(label ? { label } : {}), address, allowedChainIds };
  if (preset === 'full-access') {
    return { version: 1, accounts: [{ ...base, maxRisk: 'critical' }] };
  }
  if (preset === 'full-governance') {
    return { version: 1, accounts: [{ ...base, allowedMethods: [...FULL_GOVERNANCE_METHODS], allowedSelectors: [...FULL_GOVERNANCE_SELECTORS], maxValueWei: '0', maxRisk: 'critical' }] };
  }
  return {
    version: 1,
    accounts: [{
      ...base,
      allowedTargets: [ONEHIVE.CONVICTION_VOTING, CELESTE.COURT],
      allowedMethods: [...SAFE_AUTOMATION_METHODS],
      allowedSelectors: [...SAFE_AUTOMATION_SELECTORS],
      maxValueWei: '0',
      maxRisk: 'medium'
    }]
  };
}

export function buildDefaultSafeAutomationPolicy(input: { address: HexAddress; label?: string; chainIds?: ChainId[] } | HexAddress): KeystorePolicyFile {
  return buildKeystorePolicyPreset(input);
}

export function defaultKeystorePolicyPath(): string {
  return process.env.HONEY_KEYSTORE_POLICY ?? `${getKeystoreDir()}/policy.json`;
}

function normalizeSelector(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const lower = selector.toLowerCase();
  return /^0x[a-f0-9]{8}$/.test(lower) ? lower : undefined;
}

export async function loadKeystorePolicy(path = defaultKeystorePolicyPath()): Promise<KeystorePolicyFile> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid keystore policy file.');
  const policy = parsed as KeystorePolicyFile;
  if (policy.version !== 1 || !Array.isArray(policy.accounts)) throw new Error('Unsupported keystore policy format.');
  return policy;
}

export function evaluateKeystorePolicy(input: {
  policy: KeystorePolicyFile;
  tx: TxPreview;
  account: HexAddress;
  selector?: string;
}): PolicyCheck[] {
  const { policy, tx, account } = input;
  const selector = normalizeSelector(input.selector ?? (tx.data.length >= 10 ? tx.data.slice(0, 10) : undefined));
  const accountPolicy = policy.accounts.find((entry) => entry.address.toLowerCase() === account.toLowerCase() || (entry.label && entry.label === tx.from));
  const checks: PolicyCheck[] = [];

  checks.push({
    name: 'keystore-policy-present',
    status: accountPolicy ? 'pass' : 'fail',
    detail: accountPolicy ? 'A keystore policy matched the signing account.' : `No keystore policy matched account ${account}.`
  });
  if (!accountPolicy) return checks;

  checks.push({
    name: 'keystore-account',
    status: tx.from?.toLowerCase() === account.toLowerCase() ? 'pass' : 'fail',
    detail: tx.from?.toLowerCase() === account.toLowerCase() ? 'Keystore account matches tx.from.' : `Keystore account ${account} does not match tx.from ${tx.from ?? '(missing)'}.`
  });

  checks.push({
    name: 'keystore-chain',
    status: accountPolicy.allowedChainIds.includes(tx.chainId) ? 'pass' : 'fail',
    detail: accountPolicy.allowedChainIds.includes(tx.chainId) ? `Chain ${tx.chainId} is allowed by keystore policy.` : `Chain ${tx.chainId} is not allowed by keystore policy.`
  });

  if (accountPolicy.allowedTargets?.length) {
    const allowed = accountPolicy.allowedTargets.some((target) => target.toLowerCase() === tx.to.toLowerCase());
    checks.push({ name: 'keystore-target', status: allowed ? 'pass' : 'fail', detail: allowed ? 'Target is allowed by keystore policy.' : `Target ${tx.to} is not allowed by keystore policy.` });
  }

  if (accountPolicy.allowedSelectors?.length) {
    const allowed = Boolean(selector && accountPolicy.allowedSelectors.map((item) => item.toLowerCase()).includes(selector));
    checks.push({ name: 'keystore-selector', status: allowed ? 'pass' : 'fail', detail: allowed ? `Selector ${selector} is allowed by keystore policy.` : `Selector ${selector ?? '(missing)'} is not allowed by keystore policy.` });
  }

  if (accountPolicy.allowedMethods?.length) {
    const allowed = accountPolicy.allowedMethods.includes(tx.decoded.method) || accountPolicy.allowedMethods.includes(`${tx.decoded.contractName}.${tx.decoded.method}`);
    checks.push({ name: 'keystore-method', status: allowed ? 'pass' : 'fail', detail: allowed ? `Method ${tx.decoded.method} is allowed by keystore policy.` : `Method ${tx.decoded.method} is not allowed by keystore policy.` });
  }

  if (accountPolicy.maxValueWei !== undefined) {
    const allowed = BigInt(tx.value || '0') <= BigInt(accountPolicy.maxValueWei);
    checks.push({ name: 'keystore-value', status: allowed ? 'pass' : 'fail', detail: allowed ? `Value ${tx.value} is within keystore policy cap.` : `Value ${tx.value} exceeds keystore policy cap ${accountPolicy.maxValueWei}.` });
  }

  if (accountPolicy.maxRisk !== undefined) {
    const allowed = RISK_ORDER[tx.policy.risk] <= RISK_ORDER[accountPolicy.maxRisk];
    checks.push({ name: 'keystore-risk', status: allowed ? 'pass' : 'fail', detail: allowed ? `Risk ${tx.policy.risk} is within keystore policy cap.` : `Risk ${tx.policy.risk} exceeds keystore policy cap ${accountPolicy.maxRisk}.` });
  }

  return checks;
}
