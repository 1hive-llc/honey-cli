import { encodeAbiParameters, encodeFunctionData, isAddress, keccak256, maxUint256, zeroAddress, type Address } from 'viem';
import { ONEHIVE, addressFromEnvOrReference } from '../../src/onehive/addresses.js';
import type { ChainClient } from '../../src/onehive/clients/chain.js';
import { buildTxPreview } from '../../src/onehive/clients/tx.js';
import { fail, ok, type OneHiveToolResult, type TxPreview } from '../../src/onehive/schemas.js';
import { readAgreementState } from '../../src/onehive/tools/celeste.js';
import { simulateContractPreviewWithPolicy } from '../../src/onehive/tools/tx-preflight.js';

import { agreementResolutionAbi as resolveAbi } from '../../src/onehive/abis/agreement.js';
import { adapterAbi } from '../../src/kleros-court/abis.js';

export async function previewAgreementResolve(
  input: { chainId: number; actionId: string; from: string; expectedAdapter: string },
  client: ChainClient
): Promise<OneHiveToolResult<TxPreview>> {
  const { chainId } = input;
  if ((chainId !== 100 && chainId !== 10200 && chainId !== 31337) ||
      typeof input.actionId !== 'string' || !/^\d{1,78}$/.test(input.actionId) || BigInt(input.actionId) > maxUint256 ||
      !isAddress(input.from) || input.from === zeroAddress || !isAddress(input.expectedAdapter) || input.expectedAdapter === zeroAddress) {
    return fail('invalid_input', 'Supply a supported chain, decimal uint256 Agreement action ID, caller and expected Kleros adapter.');
  }
  try {
    const agreement = addressFromEnvOrReference('ONEHIVE_AGREEMENT', 'onehive', 'agreement', ONEHIVE.AGREEMENT);
    const state = await readAgreementState({ chainId, actionId: input.actionId }, { client });
    if (!state.ok) return fail('agreement_read_failed', 'Check the RPC chain, Agreement address and action ID.');
    const { action, challenge } = state.data ?? {};
    if (action?.closed || !action?.lastChallengeActive || challenge?.state !== 'Disputed' ||
        challenge.actionId !== action.actionId || challenge.challengeId !== action.lastChallengeId) {
      return fail('no_active_dispute', 'Resolution requires an open action with a matching active disputed challenge.');
    }
    const args = [BigInt(challenge.disputeId)] as const;
    const setting = await client.readContract<readonly [Address, Address, string, string]>({
      address: agreement, abi: resolveAbi, functionName: 'getSetting', args: [BigInt(action.settingId)]
    }).catch(() => undefined);
    if (setting?.[0]?.toLowerCase() !== input.expectedAdapter.toLowerCase()) {
      return fail('unknown_court', 'The action setting could not be verified against the expected Kleros adapter.');
    }
    const binding = await Promise.all([
      client.readContract<Address>({ address: input.expectedAdapter, abi: adapterAbi, functionName: 'agreement' }),
      client.readContract<readonly [bigint, bigint, boolean, boolean]>({
        address: input.expectedAdapter, abi: adapterAbi, functionName: 'disputes', args: [...args]
      })
    ]).catch(() => undefined);
    if (!binding) return fail('unknown_court', 'Could not read the expected Kleros adapter bindings.');
    const [boundAgreement, dispute] = binding;
    const [coreId, ruling, exists, finalised] = dispute;
    const namespacedId = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [input.expectedAdapter, coreId])));
    if (boundAgreement.toLowerCase() !== agreement.toLowerCase() || !exists || namespacedId !== args[0]) {
      return fail('unknown_court', 'Could not bind the dispute to the expected Kleros adapter and Agreement.');
    }
    if (!finalised || ruling < 2n || ruling > 4n) {
      return fail('no_final_ruling', 'The adapter must record a final Agreement ruling of 2, 3 or 4.');
    }
    const preview = buildTxPreview({
      chainId, from: input.from, to: agreement, data: encodeFunctionData({ abi: resolveAbi, functionName: 'resolve', args }),
      contractName: 'Agreement', method: 'resolve',
      args: { disputeId: challenge.disputeId },
      humanSummary: `Apply Kleros ruling ${ruling} (Agreement encoding) for dispute ${challenge.disputeId} to Agreement action ${action.actionId}, challenge ${challenge.challengeId}.`,
      risk: 'critical'
    });
    const simulated = await simulateContractPreviewWithPolicy({
      client, preview, abi: resolveAbi, functionName: 'resolve', args: [...args], account: input.from,
      policy: { abiLockStatus: 'missing', methodSelectorKnown: false }
    });
    if (simulated.policy.checks.some(check => check.name === 'target-bytecode' && check.status === 'fail')) {
      return fail('no_agreement_code', 'The configured Agreement has no bytecode.');
    }
    if (simulated.simulation.status !== 'success') {
      return fail('simulation_reverted', 'Agreement.resolve simulation failed. Check final ruling delivery and current challenge state.');
    }
    return ok(simulated, [
      'Resolution applies the ruling and can release or slash collateral. Check the application state before a separate execution preview.',
      'The pinned submit policy has no Agreement.resolve selector lock. This unsigned preview is for review.'
    ]);
  } catch {
    return fail('resolve_preview_failed', 'Could not build the Agreement resolution preview. Check the connection and contract configuration.');
  }
}
