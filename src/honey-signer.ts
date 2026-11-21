import 'dotenv/config';
import { stderr as processStderr, stdout as processStdout } from 'node:process';
import { startSignerDaemon, unlockSignerFromKeystore } from './onehive/signer-daemon.js';

function parseArgs(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const name = arg.slice(2).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());
    flags[name] = args[i + 1] && !args[i + 1]!.startsWith('--') ? args[++i]! : true;
  }
  return { command: positional[0] ?? 'start', flags };
}

function flag(flags: Record<string, string | boolean>, name: string): string | undefined {
  return typeof flags[name] === 'string' ? flags[name] as string : undefined;
}

export async function runHoneySigner(args: string[]): Promise<number> {
  const { command, flags } = parseArgs(args);
  if (command === 'help' || flags.help) {
    processStdout.write('Usage: honey-signer start --keystore LABEL [--socket .pi/honey-signer.sock | --host 127.0.0.1 --port 19777]\n');
    return 0;
  }
  if (command !== 'start') {
    processStderr.write(`Unknown honey-signer command: ${command}\n`);
    return 1;
  }
  try {
    const identifier = flag(flags, 'keystore') ?? flag(flags, 'keystoreAccount') ?? flag(flags, 'account');
    if (!identifier) throw new Error('--keystore LABEL_OR_ADDRESS is required.');
    const signer = await unlockSignerFromKeystore(identifier, flag(flags, 'dir'));
    const host = flag(flags, 'host');
    const portFlag = flag(flags, 'port');
    const socketPath = flag(flags, 'socket') ?? flag(flags, 'socketPath');
    const daemon = await startSignerDaemon({ signer, ...(host ? { host } : {}), ...(portFlag ? { port: Number(portFlag) } : {}), ...(socketPath ? { socketPath } : {}) });
    processStdout.write(`honey-signer listening at ${daemon.url} for ${signer.label} ${signer.address}\n`);
    await new Promise<void>(() => undefined);
    return 0;
  } catch (error) {
    processStderr.write(`${error instanceof Error ? error.message : 'honey-signer failed.'}\n`);
    return 1;
  }
}

export async function main(): Promise<void> {
  process.exit(await runHoneySigner(process.argv.slice(2)));
}
