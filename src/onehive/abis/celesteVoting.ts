export const celesteVotingAbi = [
  { type: 'function', name: 'commit', stateMutability: 'nonpayable', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_commitment', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'reveal', stateMutability: 'nonpayable', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_voter', type: 'address' }, { name: '_outcome', type: 'uint8' }, { name: '_salt', type: 'bytes32' }], outputs: [] },
  { type: 'function', name: 'isValidOutcome', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_outcome', type: 'uint8' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'getMaxAllowedOutcome', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }], outputs: [{ type: 'uint8' }] }
] as const;
