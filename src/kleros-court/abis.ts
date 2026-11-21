import { parseAbi } from 'viem';

// Kleros candidate abac549. Round and AdditionalCourtParams are returned as single tuples.
export const coreAbi = parseAbi([
  'struct Round { uint256 disputeKitID; uint256 pnkAtStakePerJuror; uint256 totalFeesForJurors; uint256 nbVotes; uint256 repartitions; uint256 pnkPenalties; address[] drawnJurors; uint96[] drawnJurorFromCourtIDs; uint256 sumFeeRewardPaid; uint256 sumPnkRewardPaid; address feeToken; uint256 drawIterations; uint256 courtParamsIndex; uint256[10] __gap; }',
  'struct AdditionalCourtParams { bool hiddenVotes; uint256 jurorsForCourtJump; uint256[4] timesPerPeriod; }',
  'function pinakion() view returns (address)',
  'function sortitionModule() view returns (address)',
  'function jurorNft() view returns (address)',
  'function paused() view returns (bool)',
  'function arbitrationPaused() view returns (bool)',
  'function arbitrationPauseGracePeriodEnd() view returns (uint256)',
  'function courts(uint256) view returns (uint96 parent, uint256 minStake, uint256 alpha, uint256 feeForJuror, address eligibility)',
  'function disputes(uint256) view returns (uint96 courtID, address arbitrated, uint8 period, bool ruled, uint256 lastPeriodChange)',
  'function getNumberOfRounds(uint256) view returns (uint256)',
  'function getRoundInfo(uint256,uint256) view returns (Round)',
  'function getAdditionalCourtParams(uint96,uint256) view returns (AdditionalCourtParams)',
  'function disputeKits(uint256) view returns (address)',
  'function currentRuling(uint256) view returns (uint256 ruling, bool tied, bool overridden)',
  'function setStake(uint96 courtID,uint256 newStake)',
  'function draw(uint256 disputeID,uint256 iterations) returns (uint256)',
  'function passPeriod(uint256 disputeID)',
  'function execute(uint256 disputeID,uint256 round,uint256 iterations)',
  'function executeRuling(uint256 disputeID)'
]);

export const sortitionAbi = parseAbi([
  'function core() view returns (address)',
  'function phase() view returns (uint8)',
  'function rng() view returns (address)',
  'function lastPhaseChange() view returns (uint256)',
  'function minStakingTime() view returns (uint256)',
  'function maxDrawingTime() view returns (uint256)',
  'function disputesWithoutJurors() view returns (uint256)',
  'function delayedStakeReadIndex() view returns (uint256)',
  'function delayedStakeWriteIndex() view returns (uint256)',
  'function getJurorBalance(address,uint96) view returns (uint256 total, uint256 locked, uint256 stakedInCourt, uint256 nbCourts)',
  'function stakeWeightStrategy() view returns (address)',
  'function stakeIdentityOfWallet(address) view returns (address)',
  'function totalStaked() view returns (uint256)',
  'function maxTotalStaked() view returns (uint256)',
  'function maxStakePerJuror() view returns (uint256)',
  'function getJurorLeftoverPNK(address) view returns (uint256)',
  'function passPhase()',
  'function executeDelayedStakes(uint256 iterations)',
  'function withdrawLeftoverPNK(address account)'
]);

export const strategyAbi = parseAbi([
  'function usesIdentityWeight(uint96) view returns (bool)',
  'function identityOf(address) view returns (address)'
]);
export const eligibilityAbi = parseAbi(['function isEligible(address,uint96) view returns (bool)']);
export const classicAbi = parseAbi([
  'function core() view returns (address)',
  'function coreDisputeIDToActive(uint256) view returns (bool dispute, bool currentRound)',
  'function getVoteInfo(uint256,uint256,uint256) view returns (address account, bytes32 commit, uint256 choice, bool voted)',
  'function areVotesAllCast(uint256) view returns (bool)',
  'function isAppealFunded(uint256) view returns (bool)',
  'function getCoherentCount(uint256,uint256) view returns (uint256)',
  'function castVote(uint256 coreDisputeID,uint256[] voteIDs,uint256 choice,uint256 salt,string justification)'
]);
export const adapterAbi = parseAbi([
  'function core() view returns (address)',
  'function honey() view returns (address)',
  'function agreement() view returns (address)',
  'function agreementDisputeByCore(uint256) view returns (uint256)',
  'function disputes(uint256) view returns (uint256 coreId,uint256 agreementRuling,bool exists,bool finalised)'
]);
