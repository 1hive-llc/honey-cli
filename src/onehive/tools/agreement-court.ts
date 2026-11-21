import { encodeAbiParameters, isAddress, keccak256, parseAbi, zeroAddress, type Abi, type ContractFunctionArgs,
  type ContractFunctionName, type ContractFunctionReturnType } from 'viem';
import { agreementAbi, agreementChallengeStates, agreementResolutionAbi } from '../abis/agreement.js';
import { convictionVotingAbi } from '../abis/convictionVoting.js';
import { disputableVotingAbi } from '../abis/disputableVoting.js';
import { CELESTE } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import { addressSchema, chainIdSchema } from '../schema-fields.js';
import { fail, ok, type ChainId, type HexAddress } from '../schemas.js';
import type { ToolDefinition } from '../tool-types.js';
import { agreementAddress } from './celeste.js';
import { decisionVotingAddress } from './decision.js';
import { convictionVotingAddress } from './governance.js';
import { adapterAbi } from './kleros.js';

// Agreement faf3df6d, KlerosAgreementAdapter and the vendored Honey/Kleros Core.
const coreDisputeAbi = parseAbi([
  'function disputes(uint256) view returns (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)'
]);

type Input = {
  chainId?: ChainId;
  agreement?: HexAddress;
  proposalId?: string;
  voteId?: string;
  adapter?: HexAddress;
};

function atBlock(client: ChainClient, blockNumber: bigint) {
  return <A extends Abi, F extends ContractFunctionName<A, 'view'>>(address: HexAddress, abi: A, functionName: F,
    ...args: ContractFunctionArgs<A, 'view', F> & readonly unknown[]) =>
    client.readContract<ContractFunctionReturnType<A, 'view', F>>({ address, abi, functionName, args: [...args], blockNumber });
}

type Read = ReturnType<typeof atBlock>;
type Kind = 'configured-kleros-adapter' | 'legacy-celeste' | 'unknown';

class AgreementLinkError extends Error {}

function sameAddress(a: HexAddress, b?: HexAddress) {
  return a.toLowerCase() === b?.toLowerCase();
}

async function readKlerosDispute(read: Read, arbitrator: HexAddress, agreement: HexAddress, id: bigint, warnings: string[]) {
  try {
    const [boundAgreement, core, [coreId, ruling, exists, finalised]] = await Promise.all([
      read(arbitrator, adapterAbi, 'agreement'), read(arbitrator, adapterAbi, 'core'), read(arbitrator, adapterAbi, 'disputes', id)
    ]);
    const expectedId = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [arbitrator, coreId])));
    if (!sameAddress(boundAgreement, agreement) || sameAddress(core, zeroAddress) || !exists || id !== expectedId ||
      (finalised && (ruling < 2n || ruling > 4n))) throw new Error();

    const adapter = { core, coreDisputeId: coreId.toString(), finalised, adapterAgreementRuling: finalised ? ruling.toString() : null };
    try {
      const [courtId, arbitrated, period, coreRuled] = await read(core, coreDisputeAbi, 'disputes', coreId);
      if (!sameAddress(arbitrated, arbitrator)) throw new Error();
      if (coreRuled !== finalised) warnings.push('Core and the adapter report different ruling finality.');
      return { ...adapter, currentCourtId: courtId.toString(), coreRuled, periodCode: period,
        period: ['evidence', 'commit', 'vote', 'appeal', 'execution'][period] ?? 'unknown' };
    } catch {
      warnings.push('Kleros Core dispute details are unavailable. Check the Core getter and arbitrated adapter.');
      return { ...adapter, currentCourtId: null, coreRuled: null, periodCode: null, period: null };
    }
  } catch {
    warnings.push('Kleros adapter dispute details are unavailable. Check the configured adapter, Agreement binding and namespaced dispute ID.');
    return null;
  }
}

async function readSelectedAction(read: Read, kind: 'conviction' | 'decision', agreement: HexAddress, id: bigint,
  getSetting: (id: bigint) => Promise<Setting>, warnings: string[]) {
  const app = kind === 'conviction' ? convictionVotingAddress() : decisionVotingAddress();
  const actionId = kind === 'conviction' ? (await read(app, convictionVotingAbi, 'getProposal', id))[6]
    : (await read(app, disputableVotingAbi, 'getVote', id))[7];
  if (actionId === 0n) throw new AgreementLinkError('The selected app record has no linked Agreement action.');
  const [disputable, localId, collateralId, settingId, , closed, , challengeId, active] =
    await read(agreement, agreementAbi, 'getAction', actionId);
  if (!sameAddress(disputable, app) || localId !== id) throw new AgreementLinkError('The Agreement action points to a different app or local ID.');
  const setting = await getSetting(settingId);
  let challenge = null;
  if (challengeId !== 0n) {
    const [linkedActionId, , , , , code, , , disputeId, ruling] = await read(agreement, agreementAbi, 'getChallenge', challengeId);
    if (linkedActionId !== actionId) throw new AgreementLinkError('The latest challenge points to a different Agreement action.');
    // Agreement's challenge enum differs from the arbitrator ruling codes (3 challenger, 4 submitter).
    const state = agreementChallengeStates[code] ?? 'Unknown';
    const resolved = state === 'Rejected' || state === 'Accepted' || state === 'Voided';
    // Zero is both the unassigned storage default and a valid arbitrator dispute ID.
    const disputed = state === 'Disputed' || resolved;
    if (state === 'Unknown') warnings.push('Unknown Agreement challenge state. Dispute and ruling linkage is ambiguous.');
    const court = disputed && setting.kind === 'configured-kleros-adapter'
      ? await readKlerosDispute(read, setting.arbitrator, agreement, disputeId, warnings) : null;
    if (resolved && court && court.adapterAgreementRuling !== ruling.toString()) {
      warnings.push('The resolved Agreement ruling and the configured adapter’s final ruling disagree.');
    }
    challenge = { challengeId: challengeId.toString(), active, stateCode: code, state,
      disputeId: disputed ? disputeId.toString() : null, agreementRuling: resolved ? ruling.toString() : null, court };
  }
  return { kind, app, appId: id.toString(), actionId: actionId.toString(), closed,
    collateralRequirementId: collateralId.toString(), setting, latestChallenge: challenge,
    challengeState: challenge?.state ?? 'Unchallenged' };
}

type Setting = {
  settingId: string; arbitrator: HexAddress; kind: Kind; aragonAppFeesCashier: HexAddress; title: string; content: string;
};

const idSchema = { type: 'string', pattern: '^\\d{1,78}$' };
const properties = { chainId: chainIdSchema, agreement: addressSchema, adapter: addressSchema, proposalId: idSchema, voteId: idSchema };

export async function readAgreementCourtStatus(input: Input, suppliedClient?: ChainClient) {
  if (Object.keys(input).some(key => !Object.hasOwn(properties, key))) {
    return fail('invalid_arguments', 'Unknown Agreement court status argument. Select an action with proposalId or voteId.');
  }
  const chainId = input.chainId === undefined ? 100 : input.chainId;
  const agreement = input.agreement === undefined ? agreementAddress() : input.agreement;
  const legacyCourt = chainId === 100 ? CELESTE.COURT : undefined;
  const selected = input.proposalId === undefined ? input.voteId : input.proposalId;
  if (!chainIdSchema.enum.includes(chainId)) return fail('invalid_court_configuration', 'Use chain 100, 10200 or 31337.');
  for (const address of [agreement, input.adapter]) {
    if (address !== undefined && (typeof address !== 'string' || !isAddress(address) || sameAddress(address, zeroAddress))) {
      return fail('invalid_court_configuration', 'Agreement and adapter addresses must be valid and nonzero.');
    }
  }
  if (input.adapter && sameAddress(input.adapter, legacyCourt)) {
    return fail('invalid_court_configuration', 'The specified Kleros adapter matches the Gnosis legacy Celeste court.');
  }
  if ((input.proposalId !== undefined && input.voteId !== undefined) || (selected !== undefined &&
    (typeof selected !== 'string' || !/^\d{1,78}$/.test(selected) || BigInt(selected) >= 2n ** 256n))) {
    return fail('invalid_action_selector', 'Select one Conviction proposal or Decision vote with an unsigned uint256 decimal ID.');
  }

  try {
    const client = suppliedClient ?? createChainClientFromEnv(chainId);
    const activeChain = await client.getChainId();
    if (activeChain !== chainId) return fail('wrong_chain', `RPC chain ${activeChain} differs from requested chain ${chainId}.`);
    if (!client.getBlockNumber) return fail('block_unavailable', 'The RPC client must support block-number reads.');
    const block = await client.getBlockNumber();
    const read = atBlock(client, block);
    const warnings: string[] = [];
    async function getSetting(id: bigint): Promise<Setting> {
      const [arbitrator, aragonAppFeesCashier, title, content] = await read(agreement, agreementResolutionAbi, 'getSetting', id);
      const kind = sameAddress(arbitrator, input.adapter) ? 'configured-kleros-adapter' : sameAddress(arbitrator, legacyCourt) ? 'legacy-celeste' : 'unknown';
      if (kind === 'legacy-celeste') warnings.push(`Setting ${id} uses legacy Celeste. Court details are available only for Honey/Kleros.`);
      if (kind === 'unknown') warnings.push(`Setting ${id} has an unrecognized arbitrator. Court-specific details are unavailable.`);
      return { settingId: id.toString(), arbitrator, kind, aragonAppFeesCashier, title, content };
    }
    const currentId = await read(agreement, agreementAbi, 'getCurrentSettingId');
    const currentSetting = await getSetting(currentId);
    const kind = input.proposalId === undefined ? 'decision' : 'conviction';
    const action = selected === undefined ? null : await readSelectedAction(read, kind, agreement, BigInt(selected),
      id => id === currentId ? Promise.resolve(currentSetting) : getSetting(id), warnings);
    return ok({ chainId, blockNumber: block.toString(), agreement, currentSetting, action }, warnings);
  } catch (error) {
    if (error instanceof AgreementLinkError) return fail('agreement_link_mismatch', error.message);
    return fail('agreement_court_read_failed', 'Unable to read the selected app or Agreement record at the requested chain and block.', undefined, true);
  }
}

export const agreementCourtStatusTool = {
  name: 'onehive_agreement_courtStatus',
  description: 'Read current Agreement settings and an optional Conviction proposal or Decision vote’s saved settings and latest challenge.',
  inputSchema: { type: 'object', additionalProperties: false, properties },
  handler: readAgreementCourtStatus
} satisfies ToolDefinition<Input, unknown>;
