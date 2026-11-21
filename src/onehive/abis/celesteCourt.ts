export const celesteCourtAbi = [
  { type: 'function', name: 'getCurrentTermId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'getNeededTermTransitions', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'getTermDuration', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint64' }] },
  { type: 'function', name: 'getVoting', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'getDisputeManager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'heartbeat', stateMutability: 'nonpayable', inputs: [{ name: '_maxRequestedTransitions', type: 'uint64' }], outputs: [] }
] as const;
