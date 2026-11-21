import { z } from 'zod';
import { detectLikelySecret } from '../onehive/policy.js';
import { address, chainId, uint } from './snapshot.js';

const base = { chainId, core: address, honey: address, from: address };
const court = { ...base, courtId: uint.refine(id => id > 0n && id < 2n ** 96n) };
const stake = { ...court, targetRaw: uint };
const dispute = { ...base, agreement: address, adapter: address, classic: address, challengeId: uint, roundId: uint };
const iterations = uint.refine(n => n > 0n);
const voteIds = z.array(uint).min(1).refine(ids => new Set(ids).size === ids.length);

export const commands = z.discriminatedUnion('command', [
  z.strictObject({ command: z.literal('approve-stake'), ...stake }),
  z.strictObject({ command: z.literal('stake'), ...stake }),
  z.strictObject({ command: z.literal('clear-stake-allowance'), ...base }),
  z.strictObject({ command: z.literal('pass-phase'), ...base, phase: z.enum(['staking', 'generating', 'drawing']) }),
  z.strictObject({ command: z.literal('execute-delayed-stakes'), ...base, iterations }),
  z.strictObject({ command: z.literal('withdraw-leftover'), ...base, beneficiary: address }),
  z.strictObject({ command: z.literal('my-votes'), ...dispute }),
  z.strictObject({ command: z.literal('draw'), ...dispute, iterations }),
  z.strictObject({ command: z.literal('pass-period'), ...dispute, period: z.enum(['evidence', 'vote', 'appeal']) }),
  z.strictObject({ command: z.literal('vote'), ...dispute, voteIds,
    choice: z.enum(['refuse', 'challenger', 'submitter']),
    justification: z.string().refine(s => detectLikelySecret(s).length === 0) }),
  z.strictObject({ command: z.literal('execute-rewards'), ...dispute, iterations }),
  z.strictObject({ command: z.literal('execute-ruling'), ...dispute }),
  z.strictObject({ command: z.literal('resolve'), ...dispute }),
  z.strictObject({ command: z.literal('settlement'), ...dispute })
]);

export type Command = z.infer<typeof commands>;
export type DisputeCommand = Extract<Command, { challengeId: bigint }>;
export type JurorOrPhaseCommand = Exclude<Command, DisputeCommand>;
