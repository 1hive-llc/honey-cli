// Optional independent check using solc --abi output from the pinned contract checkout.
import { deepStrictEqual, ok } from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { toFunctionSignature, type Abi, type AbiParameter } from 'viem';
import { adapterAbi, classicAbi, coreAbi, eligibilityAbi, sortitionAbi, strategyAbi } from '../../src/kleros-court/abis.js';

function layout(p: AbiParameter): unknown {
  if ('components' in p) return [p.type, p.components.map(component => [component.name, layout(component)])];
  return p.type;
}

const path = process.argv[2];
if (!path) throw new Error('Supply the directory containing solc .abi output.');
let count = 0;
for (const [contract, subset] of Object.entries({
  KlerosCore: coreAbi, SortitionModule: sortitionAbi, DisputeKitClassic: classicAbi,
  KlerosAgreementAdapter: adapterAbi, ICourtEligibility: eligibilityAbi, HoneyStakeWeightStrategy: strategyAbi
})) {
  const compiled: Abi = JSON.parse(readFileSync(join(path, contract + '.abi'), 'utf8'));
  for (const fn of subset) {
    const sig = toFunctionSignature(fn);
    const actual = compiled.find(f => f.type === 'function' && toFunctionSignature(f) === sig);
    ok(actual?.type === 'function', contract + '.' + sig);
    deepStrictEqual(actual.stateMutability, fn.stateMutability, sig);
    deepStrictEqual(actual.outputs.map(layout), fn.outputs.map(layout), sig);
    count++;
  }
}
console.log(`Matched ${count} candidate signatures, return layouts and mutabilities.`);
