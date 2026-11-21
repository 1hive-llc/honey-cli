import { createInterface } from 'node:readline/promises';
import { stdin as processStdin, stdout as processStdout } from 'node:process';

export type SecretInput = {
  question: string;
  input?: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => void };
  output?: NodeJS.WritableStream & { isTTY?: boolean };
};

/**
 * Read a secret from an interactive TTY. The default implementation avoids
 * echoing typed characters by temporarily muting readline output. Tests should
 * inject a provider instead of exercising terminal behavior directly.
 */
export async function readSecretFromTty(input: SecretInput): Promise<string> {
  const source = input.input ?? processStdin;
  const output = input.output ?? processStdout;
  if (!source.isTTY || !output.isTTY) throw new Error('Interactive secret input requires a TTY. Use an external signer in non-interactive agent contexts.');

  let muted = false;
  const mutableOutput = output as NodeJS.WritableStream & { write: (chunk: unknown, encoding?: unknown, cb?: unknown) => boolean };
  const originalWrite = mutableOutput.write.bind(mutableOutput);
  mutableOutput.write = ((chunk: unknown, encoding?: unknown, cb?: unknown) => {
    if (muted) {
      if (typeof cb === 'function') cb();
      return true;
    }
    return originalWrite(chunk, encoding as BufferEncoding, cb as (() => void) | undefined);
  }) as typeof mutableOutput.write;

  const rl = createInterface({ input: source, output, terminal: true });
  try {
    muted = true;
    const value = await rl.question(input.question);
    muted = false;
    originalWrite('\n');
    if (!value) throw new Error('Secret input was empty.');
    return value;
  } finally {
    muted = false;
    mutableOutput.write = originalWrite as typeof mutableOutput.write;
    rl.close();
  }
}
