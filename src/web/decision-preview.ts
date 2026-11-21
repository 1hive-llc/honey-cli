import { getAddress } from 'viem';
import type { ChainClient, ContractReadRequest } from '../onehive/clients/chain.js';
import type { HexAddress } from '../onehive/schemas.js';
import { buildDecisionCastVotePreview } from '../onehive/tools/decision.js';
import { QueryFailure, validAddress, validId, type Profile } from './profile.js';

export type DecisionVotePreviewInput = { id: string; account: HexAddress; supports: boolean };

export async function previewDecisionVote(p: Profile, input: DecisionVotePreviewInput, client: ChainClient) {
  if (!p.jurySimulation || p.chainId !== 31337 || typeof input.id !== 'string' || !validId(input.id) ||
      !validAddress(input.account) || typeof input.supports !== 'boolean') throw new QueryFailure('decision-not-ready');
  if (await client.getChainId() !== p.chainId) throw new QueryFailure('wrong-chain');
  if (!client.getBlockNumber) throw new QueryFailure('unavailable');
  const blockNumber = await client.getBlockNumber();
  const account = getAddress(input.account);
  const { sendTransaction: _unused, ...readOnly } = client;
  let abnormal = false;
  const result = await buildDecisionCastVotePreview({ voteId: input.id, from: account, supports: input.supports, chainId: p.chainId }, {
    client: { ...readOnly, async readContract<T>(req: ContractReadRequest) {
      const value = await client.readContract<T>({ ...req, blockNumber });
      // Require Normal independently of the two voting-permission getters.
      if (req.functionName === 'getVote' && (!Array.isArray(value) || value[5] !== 0)) {
        abnormal = true;
        throw new QueryFailure('decision-not-ready');
      }
      return value;
    } }
  });
  if (abnormal || ['vote_not_open', 'cannot_vote'].includes(result.error?.code ?? '')) throw new QueryFailure('decision-not-ready');
  if (result.error?.code === 'simulation_reverted') throw new QueryFailure('simulation');
  if (!result.ok || !result.data) throw new QueryFailure('unavailable');
  if (result.data.simulation.status !== 'success' || result.data.policy.checks.some(check => check.status === 'fail')) throw new QueryFailure('simulation');
  return { id: input.id, account, supports: input.supports, simulation: 'success' as const, submitted: false as const };
}
