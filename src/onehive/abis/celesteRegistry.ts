export const celesteRegistryAbi = [
  { type: 'function', name: 'stakeFor', stateMutability: 'nonpayable', inputs: [{ name: '_user', type: 'address' }, { name: '_amount', type: 'uint256' }, { name: '_data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'unstake', stateMutability: 'nonpayable', inputs: [{ name: '_amount', type: 'uint256' }, { name: '_data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'activate', stateMutability: 'nonpayable', inputs: [{ name: '_amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'deactivate', stateMutability: 'nonpayable', inputs: [{ name: '_amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: '_user', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'activeBalanceOf', stateMutability: 'view', inputs: [{ name: '_user', type: 'address' }], outputs: [{ type: 'uint256' }] }
] as const;
