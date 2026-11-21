export const convictionVotingAbi = [
  { type: 'event', name: 'ProposalAdded', inputs: [
    { name: 'entity', type: 'address', indexed: true },
    { name: 'id', type: 'uint256', indexed: true },
    { name: 'actionId', type: 'uint256', indexed: true },
    { name: 'title', type: 'string', indexed: false },
    { name: 'link', type: 'bytes', indexed: false },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'stable', type: 'bool', indexed: false },
    { name: 'beneficiary', type: 'address', indexed: false }
  ] },
  { type: 'event', name: 'StakeAdded', inputs: [
    { name: 'entity', type: 'address', indexed: true },
    { name: 'id', type: 'uint256', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'tokensStaked', type: 'uint256', indexed: false },
    { name: 'totalTokensStaked', type: 'uint256', indexed: false },
    { name: 'conviction', type: 'uint256', indexed: false }
  ] },
  { type: 'event', name: 'StakeWithdrawn', inputs: [
    { name: 'entity', type: 'address', indexed: false },
    { name: 'id', type: 'uint256', indexed: true },
    { name: 'amount', type: 'uint256', indexed: false },
    { name: 'tokensStaked', type: 'uint256', indexed: false },
    { name: 'totalTokensStaked', type: 'uint256', indexed: false },
    { name: 'conviction', type: 'uint256', indexed: false }
  ] },
  { type: 'event', name: 'ProposalExecuted', inputs: [{ name: 'id', type: 'uint256', indexed: true }, { name: 'conviction', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'ProposalCancelled', inputs: [{ name: 'proposalId', type: 'uint256', indexed: true }] },
  {
    type: 'function',
    name: 'getProposal',
    stateMutability: 'view',
    inputs: [{ name: '_proposalId', type: 'uint256' }],
    outputs: [
      { name: 'requestedAmount', type: 'uint256' },
      { name: 'stableRequestAmount', type: 'bool' },
      { name: 'beneficiary', type: 'address' },
      { name: 'stakedTokens', type: 'uint256' },
      { name: 'convictionLast', type: 'uint256' },
      { name: 'blockLast', type: 'uint64' },
      { name: 'agreementActionId', type: 'uint256' },
      { name: 'proposalStatus', type: 'uint8' },
      { name: 'submitter', type: 'address' },
      { name: 'threshold', type: 'uint256' }
    ]
  },
  { type: 'function', name: 'addProposal', stateMutability: 'nonpayable', inputs: [{ name: '_title', type: 'string' }, { name: '_link', type: 'bytes' }, { name: '_requestedAmount', type: 'uint256' }, { name: '_stableRequestAmount', type: 'bool' }, { name: '_beneficiary', type: 'address' }], outputs: [] },
  { type: 'function', name: 'stakeToProposal', stateMutability: 'nonpayable', inputs: [{ name: '_proposalId', type: 'uint256' }, { name: '_amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'stakeAllToProposal', stateMutability: 'nonpayable', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawFromProposal', stateMutability: 'nonpayable', inputs: [{ name: '_proposalId', type: 'uint256' }, { name: '_amount', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'withdrawAllFromProposal', stateMutability: 'nonpayable', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'executeProposal', stateMutability: 'nonpayable', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'cancelProposal', stateMutability: 'nonpayable', inputs: [{ name: '_proposalId', type: 'uint256' }], outputs: [] }
] as const;
