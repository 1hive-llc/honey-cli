import { parseAbi } from 'viem';

// Agreement faf3df6d. Challenge states and arbitrator ruling codes have distinct encodings.
export const agreementChallengeStates = ['Waiting', 'Settled', 'Disputed', 'Accepted', 'Rejected', 'Voided'] as const;

// Kept separate from the submission ABI and selector locks.
export const agreementResolutionAbi = parseAbi([
  'function getSetting(uint256 settingId) view returns (address arbitrator,address cashier,string title,bytes content)',
  'function resolve(uint256 disputeId)'
]);

export const agreementAbi = [
  { type: 'event', name: 'Signed', inputs: [{ name: 'signer', type: 'address', indexed: true }, { name: 'settingId', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'ActionSubmitted', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'disputable', type: 'address', indexed: true }] },
  { type: 'event', name: 'ActionClosed', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ActionChallenged', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ActionSettled', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ActionDisputed', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ActionAccepted', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ActionVoided', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ActionRejected', inputs: [{ name: 'actionId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'function', name: 'getCurrentSettingId', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'sign', stateMutability: 'nonpayable', inputs: [{ name: '_settingId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'getSigner', stateMutability: 'view', inputs: [{ name: '_signer', type: 'address' }], outputs: [{ name: 'lastSettingIdSigned', type: 'uint256' }, { name: 'mustSign', type: 'bool' }] },
  {
    type: 'function', name: 'getAction', stateMutability: 'view', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [
      { name: 'disputable', type: 'address' },
      { name: 'disputableActionId', type: 'uint256' },
      { name: 'collateralRequirementId', type: 'uint256' },
      { name: 'settingId', type: 'uint256' },
      { name: 'submitter', type: 'address' },
      { name: 'closed', type: 'bool' },
      { name: 'context', type: 'bytes' },
      { name: 'lastChallengeId', type: 'uint256' },
      { name: 'lastChallengeActive', type: 'bool' }
    ]
  },
  {
    type: 'function', name: 'getChallenge', stateMutability: 'view', inputs: [{ name: '_challengeId', type: 'uint256' }], outputs: [
      { name: 'actionId', type: 'uint256' },
      { name: 'challenger', type: 'address' },
      { name: 'endDate', type: 'uint64' },
      { name: 'context', type: 'bytes' },
      { name: 'settlementOffer', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'submitterFinishedEvidence', type: 'bool' },
      { name: 'challengerFinishedEvidence', type: 'bool' },
      { name: 'disputeId', type: 'uint256' },
      { name: 'ruling', type: 'uint256' }
    ]
  },
  {
    type: 'function', name: 'getChallengeArbitratorFees', stateMutability: 'view', inputs: [{ name: '_challengeId', type: 'uint256' }], outputs: [
      { name: 'submitterArbitratorFeesToken', type: 'address' },
      { name: 'submitterArbitratorFeesAmount', type: 'uint256' },
      { name: 'challengerArbitratorFeesToken', type: 'address' },
      { name: 'challengerArbitratorFeesAmount', type: 'uint256' }
    ]
  },
  {
    type: 'function', name: 'getCollateralRequirement', stateMutability: 'view', inputs: [{ name: '_disputable', type: 'address' }, { name: '_collateralRequirementId', type: 'uint256' }], outputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'challengeDuration', type: 'uint64' },
      { name: 'actionAmount', type: 'uint256' },
      { name: 'challengeAmount', type: 'uint256' }
    ]
  },
  { type: 'function', name: 'canChallenge', stateMutability: 'view', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'canClose', stateMutability: 'view', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'canSettle', stateMutability: 'view', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'canClaimSettlement', stateMutability: 'view', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'canDispute', stateMutability: 'view', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'challengeAction', stateMutability: 'nonpayable', inputs: [{ name: '_actionId', type: 'uint256' }, { name: '_settlementOffer', type: 'uint256' }, { name: '_finishedEvidence', type: 'bool' }, { name: '_context', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'settleAction', stateMutability: 'nonpayable', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [] },
  { type: 'function', name: 'disputeAction', stateMutability: 'nonpayable', inputs: [{ name: '_actionId', type: 'uint256' }, { name: '_submitterFinishedEvidence', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'submitEvidence', stateMutability: 'nonpayable', inputs: [{ name: '_disputeId', type: 'uint256' }, { name: '_evidence', type: 'bytes' }, { name: '_finished', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'closeAction', stateMutability: 'nonpayable', inputs: [{ name: '_actionId', type: 'uint256' }], outputs: [] }
] as const;
