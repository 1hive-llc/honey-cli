import { ZodError } from 'zod';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { fail, ok } from '../onehive/schemas.js';
import { coreAbi } from './abis.js';
import { commands, type Command } from './commands.js';
import { planDispute } from './dispute.js';
import { CourtError, MissingRead, Snapshot, requireThat } from './snapshot.js';
import { planStaking } from './staking.js';

export function planCourtCommand(r: Command, s: Snapshot) {
  requireThat(r.chainId === s.block.chainId, 'Snapshot chain differs from requested chain.');
  requireThat(s.read(coreAbi, r.core, 'pinakion', []) === r.honey && s.read(erc20Abi, r.honey, 'decimals', []) === 18,
    'Core must use the expected 18-decimal Honey token.');
  const data = 'challengeId' in r ? planDispute(s, r) : planStaking(s, r);
  const warnings = ['Public reads come from the supplied block recording. Its provenance and freshness are unverified.'];
  if (r.command === 'my-votes') warnings.push('Action and challenge context come from Agreement. Additional evidence can appear in adapter EvidenceSubmitted events.');
  if (r.command === 'resolve') warnings.push('Resolution can release or slash collateral. The Agreement.resolve selector has no native submit lock.');
  if ('preview' in data) warnings.push('Unsigned offline preview. Simulation has not run. Candidate deployment policy is unverified.');
  return ok({ block: s.block, ...data }, warnings);
}

export function runCourtCommand(input: unknown, snapshot: unknown) {
  try {
    return planCourtCommand(commands.parse(input), new Snapshot(snapshot));
  } catch (e) {
    if (e instanceof MissingRead) return fail('court_missing_read', e.message, e.request);
    if (e instanceof CourtError) return fail('court_precondition', e.message);
    if (e instanceof ZodError) return fail('court_input', `Invalid input at ${e.issues[0]?.path.join('.') || 'root'}.`);
    return fail('court_failed', 'Court recording or request could not be processed.');
  }
}
