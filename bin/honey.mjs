#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { tsImport } from 'tsx/esm/api';

const args = process.argv.slice(2);
const { isCourtRoute } = await tsImport('../src/kleros-court/routes.ts', import.meta.url);
if (isCourtRoute(args)) {
  // Recording commands never load the native signer or submission dispatcher.
  const { runCourtCli } = await tsImport('../src/kleros-court/cli.ts', import.meta.url);
  const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  process.exitCode = await runCourtCli(args, { stdin });
} else {
  const { main } = await tsImport('../src/honey-cli.ts', import.meta.url);
  await main();
}
