export const honeyswapRouter02Abi = [
  { type: 'function', name: 'getAmountsOut', stateMutability: 'view', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
  { type: 'function', name: 'getAmountsIn', stateMutability: 'view', inputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'path', type: 'address[]' }], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
  { type: 'function', name: 'swapExactTokensForTokens', stateMutability: 'nonpayable', inputs: [{ name: 'amountIn', type: 'uint256' }, { name: 'amountOutMin', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }] },
  { type: 'function', name: 'swapTokensForExactTokens', stateMutability: 'nonpayable', inputs: [{ name: 'amountOut', type: 'uint256' }, { name: 'amountInMax', type: 'uint256' }, { name: 'path', type: 'address[]' }, { name: 'to', type: 'address' }, { name: 'deadline', type: 'uint256' }], outputs: [{ name: 'amounts', type: 'uint256[]' }] }
] as const;

export const honeyswapFactoryAbi = [
  { type: 'function', name: 'getPair', stateMutability: 'view', inputs: [{ name: 'tokenA', type: 'address' }, { name: 'tokenB', type: 'address' }], outputs: [{ name: 'pair', type: 'address' }] }
] as const;

export const honeyswapPairAbi = [
  { type: 'function', name: 'getReserves', stateMutability: 'view', inputs: [], outputs: [{ name: 'reserve0', type: 'uint112' }, { name: 'reserve1', type: 'uint112' }, { name: 'blockTimestampLast', type: 'uint32' }] },
  { type: 'function', name: 'token0', stateMutability: 'view', inputs: [], outputs: [{ name: 'token0', type: 'address' }] },
  { type: 'function', name: 'token1', stateMutability: 'view', inputs: [], outputs: [{ name: 'token1', type: 'address' }] }
] as const;
