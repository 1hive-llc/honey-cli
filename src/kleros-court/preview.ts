import { encodeFunctionData, getAbiItem, zeroAddress, type Abi, type Address, type ContractFunctionArgs,
  type ContractFunctionName } from 'viem';
import { buildTxPreview } from '../onehive/clients/tx.js';
import { coreAbi, sortitionAbi } from './abis.js';
import type { Command } from './commands.js';
import { requireThat, type Snapshot } from './snapshot.js';

export function sortitionAddress(s: Snapshot, r: Command) {
  const module = s.read(coreAbi, r.core, 'sortitionModule', []);
  requireThat(module !== zeroAddress && s.read(sortitionAbi, module, 'core', []) === r.core,
    'Sortition module and Core linkage mismatch.');
  return module;
}

export function preview<const A extends Abi, F extends ContractFunctionName<A, 'nonpayable'>>(
  r: Command, contractName: string, to: Address, abi: A, method: F,
  args: ContractFunctionArgs<A, 'nonpayable', F> & readonly unknown[], humanSummary: string
) {
  const item = getAbiItem({ abi: abi as Abi, name: method as string });
  requireThat(item?.type === 'function' && item.stateMutability === 'nonpayable', 'Unsupported method.');
  const decodedArgs = Object.fromEntries(item.inputs.map((p, i) => [p.name, args[i]]));
  const data = encodeFunctionData({ abi: [item] as Abi, functionName: item.name, args: args as readonly unknown[] });
  return buildTxPreview({
    chainId: r.chainId, from: r.from, to, data, contractName, method,
    args: JSON.parse(JSON.stringify(decodedArgs, (_, v) => typeof v === 'bigint' ? v.toString() : v)),
    humanSummary, risk: r.command === 'resolve' ? 'critical' : 'high',
    checks: [
      { name: 'abi-lock', status: 'fail', detail: 'Offline candidate preview. Deployment and implementation unverified.' },
      { name: 'simulation', status: 'fail', detail: 'No transaction simulation in offline replay.' }
    ]
  });
}
