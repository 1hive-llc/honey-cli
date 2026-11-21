import {
  decodeFunctionResult, encodeFunctionData, encodeFunctionResult, getAddress, isAddress, zeroAddress,
  type Abi, type Address, type ContractFunctionArgs, type ContractFunctionName, type ContractFunctionReturnType, type Hex
} from 'viem';
import { z } from 'zod';

export class CourtError extends Error {}
export class MissingRead extends CourtError {
  constructor(readonly request: { to: Address; data: Hex; method: string; blockHash: string }) {
    super(`Missing recorded ${request.method} read.`);
  }
}
export function requireThat(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CourtError(message);
}

export const address = z.string().refine(v => isAddress(v) && v !== zeroAddress).transform(v => getAddress(v));
export const chainId = z.union([z.literal(31337), z.literal(100), z.literal(10200)]);
export const uint = z.string().regex(/^(0|[1-9]\d{0,77})$/).transform(BigInt).refine(v => v < 2n ** 256n);
const bytes = z.string().regex(/^0x([a-fA-F0-9]{2})+$/).transform(v => v.toLowerCase() as Hex);
const format = z.strictObject({
  chainId,
  blockNumber: uint,
  blockHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
  timestamp: uint,
  calls: z.array(z.strictObject({ to: address, data: bytes, result: bytes }))
});

type ReadFn<A extends Abi> = ContractFunctionName<A, 'view' | 'pure'>;

// A replay of public return bytes, indexed by target and calldata at one declared block.
// There is deliberately no transport fallback for an absent or malformed response.
export class Snapshot {
  readonly block;
  private readonly results = new Map<string, Hex>();

  constructor(input: unknown) {
    const { calls, chainId, blockHash, blockNumber, timestamp } = format.parse(input);
    this.block = { chainId, blockNumber: blockNumber.toString(), blockHash, timestamp: timestamp.toString() };
    for (const call of calls) {
      const key = call.to + call.data;
      requireThat(!this.results.has(key), 'Duplicate contract read in snapshot.');
      this.results.set(key, call.result);
    }
  }

  read<const A extends Abi, F extends ReadFn<A>>(abi: A, to: Address, name: F,
    args: ContractFunctionArgs<A, 'view' | 'pure', F> & readonly unknown[]): ContractFunctionReturnType<A, 'view' | 'pure', F> {
    const target = getAddress(to);
    const binding = { abi: abi as Abi, functionName: name as string };
    const data = encodeFunctionData({ ...binding, args });
    const result = this.results.get(target + data.toLowerCase());
    if (!result) throw new MissingRead({ to: target, data, method: name, blockHash: this.block.blockHash });
    try {
      const decoded = decodeFunctionResult({ ...binding, data: result });
      if (encodeFunctionResult({ ...binding, result: decoded }).toLowerCase() !== result) throw new Error();
      return decoded as ContractFunctionReturnType<A, 'view' | 'pure', F>;
    } catch {
      throw new CourtError(`Invalid return data for ${name}.`);
    }
  }
}
