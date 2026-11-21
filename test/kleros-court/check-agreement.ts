// Check the supplied, compiled Agreement fixture without deploying or executing its bytecode.
import { deepStrictEqual, equal, ok } from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toEventSelector, toFunctionSignature, type Abi } from 'viem';
import { agreementAbi, agreementChallengeStates, agreementResolutionAbi } from '../../src/onehive/abis/agreement.js';

const dir = process.argv[2];
if (!dir) throw new Error('Supply the pinned Agreement fixture artifacts directory.');
const manifest = JSON.parse(readFileSync(join(dir, 'source-manifest.json'), 'utf8'));
equal(manifest.sourceCommit, 'faf3df6d23845deeab515a02c7517743c620bbed');
equal(manifest.sources['contracts/Agreement.sol'], 'f85c6ec195b0e1b6a0303ed6f641aeebd2a3ab469bdb67db81f84894f26052cf');
const file = readFileSync(join(dir, 'Agreement.json'));
equal(createHash('sha256').update(file).digest('hex'), '764573e61127cf327350220ffcc5baa4b1ceb72978e2719cd672d7ba1fa08a1b');
const compiled = JSON.parse(file.toString()) as { abi: Abi; bytecode: { object: string } };
let count = 0;
for (const f of [...agreementAbi, ...agreementResolutionAbi]) {
  if (f.type !== 'function') continue;
  const match = compiled.abi.find(a => a.type === 'function' && toFunctionSignature(a) === toFunctionSignature(f));
  ok(match?.type === 'function', f.name);
  equal(match.stateMutability, f.stateMutability);
  deepStrictEqual(match.outputs.map(o => o.type), f.outputs.map(o => o.type));
  count++;
}
const getter = compiled.abi.find(f => f.type === 'function' && f.name === 'getChallenge');
ok(getter?.type === 'function');
deepStrictEqual([getter.outputs[5]?.name, getter.outputs[9]?.name], ['state', 'ruling']);

const bytecode = Buffer.from(compiled.bytecode.object.replace(/^0x/, ''), 'hex');
// Offsets in this exact creation bytecode. Each outcome routine stores the low state byte in
// challenge slot 8, calls its app callback and emits its indexed outcome event with LOG3.
for (const [state, name, store, event] of [
  [3, 'Accepted', 19855, 20071], [4, 'Rejected', 20118, 20374], [5, 'Voided', 20422, 20672]
] as const) {
  equal(agreementChallengeStates[state], name);
  equal(bytecode.subarray(store - 1, store + 15).toString('hex'), '5b60088101805460ff1916600' + state + '179055');
  const topic = toEventSelector('Action' + name + '(uint256,uint256)').slice(2);
  equal(bytecode.subarray(event, event + 38).toString('hex'), '7f' + topic + '90600090a3');
}
console.log(`Matched ${count} Agreement function signatures, return layouts and mutabilities and 3 terminal state/event pairs.`);
