#!/usr/bin/env node
import { parseArgs } from 'node:util';

const usage = 'Usage: node bin/honey-web.mjs --profile PATH [--port 0..65535]';
try {
  const { values, tokens } = parseArgs({ options: { profile: { type: 'string' }, port: { type: 'string' }, help: { type: 'boolean' } }, tokens: true });
  if (new Set(tokens.map(t => t.name)).size !== tokens.length) throw new Error();
  if (values.help && tokens.length === 1) {
    console.log(usage);
  } else {
    const port = values.port ?? '8787';
    if (values.help || !values.profile || !/^(0|[1-9]\d{0,4})$/.test(port) || Number(port) > 65535) throw new Error();
    const { tsImport } = await import('tsx/esm/api');
    const { readProfile, parseProfile } = await tsImport('../src/web/profile.ts', import.meta.url);
    const p = parseProfile(readProfile(values.profile));
    const { webServer, listen, workerRunner } = await tsImport('../src/web/server.ts', import.meta.url);
    console.log('Honey · configured profile · preview only · ' + await listen(webServer(p, workerRunner(p)), Number(port)));
  }
} catch {
  console.error(usage + '\nCould not start. Check the profile, installed dependencies and available port. See docs/LOCAL_WEB.md.');
  process.exitCode = 1;
}
