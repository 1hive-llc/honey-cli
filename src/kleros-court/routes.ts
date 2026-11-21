import type { Command } from './commands.js';

export const courtGroups = {
  juror: ['approve-stake', 'clear-stake-allowance', 'stake', 'my-votes', 'vote', 'withdraw-leftover'],
  keeper: ['pass-phase', 'draw', 'pass-period', 'execute-rewards', 'execute-ruling', 'execute-delayed-stakes'],
  case: ['settlement']
} as const satisfies Record<string, readonly Command['command'][]>;

export function isCourtRoute([area, group]: readonly string[]) {
  return (area === 'disputes' && group === 'resolve') ||
    (area === 'kleros' && group !== undefined && (Object.hasOwn(courtGroups, group) || group === 'capture'));
}

export const courtHelp = [
  ...Object.entries(courtGroups).map(([group, commands]) => `  kleros ${group} ${commands.join('|')}`),
  '  disputes resolve',
  '    Supply --snapshot BLOCK.json [--json] and request JSON on stdin. Reads and unsigned previews run offline.',
  '  kleros capture OPERATION --block HEIGHT [--json] < request.json',
  '    Read public getters for one operation. Save its JSON output for --snapshot.'
].join('\n');
