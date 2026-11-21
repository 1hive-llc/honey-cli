export const disputableVotingAbi = [
  { type: 'event', name: 'StartVote', inputs: [
    { name: 'voteId', type: 'uint256', indexed: true },
    { name: 'creator', type: 'address', indexed: true },
    { name: 'context', type: 'bytes', indexed: false },
    { name: 'executionScript', type: 'bytes', indexed: false }
  ] },
  { type: 'event', name: 'CastVote', inputs: [
    { name: 'voteId', type: 'uint256', indexed: true },
    { name: 'voter', type: 'address', indexed: true },
    { name: 'supports', type: 'bool', indexed: false },
    { name: 'caster', type: 'address', indexed: false }
  ] },
  { type: 'event', name: 'ExecuteVote', inputs: [{ name: 'voteId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'CancelVote', inputs: [{ name: 'voteId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'PauseVote', inputs: [{ name: 'voteId', type: 'uint256', indexed: true }, { name: 'challengeId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'ResumeVote', inputs: [{ name: 'voteId', type: 'uint256', indexed: true }] },
  { type: 'event', name: 'QuietEndingExtendVote', inputs: [{ name: 'voteId', type: 'uint256', indexed: true }, { name: 'passing', type: 'bool', indexed: false }] },
  { type: 'function', name: 'newVote', stateMutability: 'nonpayable', inputs: [{ name: '_executionScript', type: 'bytes' }, { name: '_context', type: 'bytes' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'vote', stateMutability: 'nonpayable', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_supports', type: 'bool' }], outputs: [] },
  { type: 'function', name: 'executeVote', stateMutability: 'nonpayable', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_executionScript', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'getSetting', stateMutability: 'view', inputs: [{ name: '_settingId', type: 'uint256' }], outputs: [
    { name: 'voteTime', type: 'uint64' },
    { name: 'supportRequiredPct', type: 'uint64' },
    { name: 'minAcceptQuorumPct', type: 'uint64' },
    { name: 'delegatedVotingPeriod', type: 'uint64' },
    { name: 'quietEndingPeriod', type: 'uint64' },
    { name: 'quietEndingExtension', type: 'uint64' },
    { name: 'executionDelay', type: 'uint64' }
  ] },
  { type: 'function', name: 'getVote', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }], outputs: [
    { name: 'yea', type: 'uint256' },
    { name: 'nay', type: 'uint256' },
    { name: 'totalPower', type: 'uint256' },
    { name: 'startDate', type: 'uint64' },
    { name: 'snapshotBlock', type: 'uint64' },
    { name: 'status', type: 'uint8' },
    { name: 'settingId', type: 'uint256' },
    { name: 'actionId', type: 'uint256' },
    { name: 'pausedAt', type: 'uint64' },
    { name: 'pauseDuration', type: 'uint64' },
    { name: 'quietEndingExtensionDuration', type: 'uint64' },
    { name: 'quietEndingSnapshotSupport', type: 'uint8' },
    { name: 'executionScriptHash', type: 'bytes32' }
  ] },
  { type: 'function', name: 'getCastVote', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_voter', type: 'address' }], outputs: [{ name: 'state', type: 'uint8' }, { name: 'caster', type: 'address' }] },
  { type: 'function', name: 'canVote', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }, { name: '_voter', type: 'address' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'canExecute', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'isVoteOpenForVoting', stateMutability: 'view', inputs: [{ name: '_voteId', type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'votesLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'settingsLength', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] }
] as const;
