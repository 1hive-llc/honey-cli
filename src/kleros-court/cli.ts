import { readFileSync } from 'node:fs';
import { fail } from '../onehive/schemas.js';
import { commands } from './commands.js';
import { courtGroups, courtHelp, isCourtRoute } from './routes.js';
import { runCourtCommand } from './run.js';

type CourtIO = { stdin?: string; stdout?: Pick<NodeJS.WriteStream, 'write'> };

export async function runCourtCli(args: string[], io: CourtIO = {}) {
  const stdout = io.stdout ?? process.stdout;
  if (args.at(-1) === '--help') {
    stdout.write(courtHelp + '\n');
    return 0;
  }
  const [area, group, ...rest] = args;
  const capture = group === 'capture';
  const command = area === 'disputes' ? 'resolve' : rest.shift();
  const json = rest.includes('--json');
  const options = rest.filter(a => a !== '--json');
  async function run() {
    if (!isCourtRoute(args)) return fail('court_usage', 'Unknown court command. See --help.');
    if (area === 'kleros' && group && !capture) {
      const allowed: readonly string[] = courtGroups[group as keyof typeof courtGroups] ?? [];
      if (!command || !allowed.includes(command)) return fail('court_usage', 'Unknown operation in this Kleros group. See --help.');
    }
    const [flag, value] = options;
    if (!command || !commands.options.some(o => o.shape.command.value === command) ||
        options.length !== 2 || rest.length !== options.length + Number(json) ||
        flag !== (capture ? '--block' : '--snapshot') || !value || value.startsWith('--')) {
      return fail('court_usage', 'Supply one operation, its --snapshot file (or --block height for capture), and request JSON on stdin.');
    }
    try {
      const request = JSON.parse(io.stdin ?? '');
      if (!request || typeof request !== 'object' || Array.isArray(request) || 'command' in request) {
        return fail('court_input', 'Supply one request object. The command comes from the CLI.');
      }
      const input = { ...request, command };
      if (capture) {
        const { captureCourtRecording } = await import('./capture.js');
        return await captureCourtRecording(input, value);
      }
      const saved = JSON.parse(readFileSync(value, 'utf8'));
      // Accept the capture command's JSON envelope as well as a plain recording.
      return runCourtCommand(input, saved?.ok === true ? saved.data : saved);
    } catch {
      return fail('court_input', 'Unable to read request or recording JSON.');
    }
  }
  const result = await run();
  stdout.write(JSON.stringify(result, null, json ? undefined : 2) + '\n');
  return result.ok ? 0 : 1;
}
