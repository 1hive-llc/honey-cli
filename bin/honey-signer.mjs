#!/usr/bin/env node
import { tsImport } from 'tsx/esm/api';

const { main } = await tsImport('../src/honey-signer.ts', import.meta.url);
await main();
