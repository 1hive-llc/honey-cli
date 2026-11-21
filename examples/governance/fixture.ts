// Synthetic contract records for UI comparison and local browser QA. No network transports.
import { custom, decodeFunctionData, encodeFunctionResult, encodeAbiParameters, keccak256, parseAbi, stringToHex, zeroAddress, type Abi, type Hex } from 'viem';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import { convictionVotingAbi } from '../../src/onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../../src/onehive/abis/disputableVoting.js';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { createViemChainClient } from '../../src/onehive/clients/chain.js';
import type { GardenProposalsParams, GardenProposalSummary } from '../../src/onehive/clients/garden.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { adapterAbi, classicAbi, coreAbi, eligibilityAbi, sortitionAbi, strategyAbi } from '../../src/kleros-court/abis.js';
import type { StakeDeps } from '../../src/web/stake.js';
import type { JuryDeps } from '../../src/web/jury.js';
import { parseProfile } from '../../src/web/profile.js';

export const adapter = '0x1111111111111111111111111111111111111111';
export const core = '0x2222222222222222222222222222222222222222';
export const actor = '0x3333333333333333333333333333333333333333';
export const kit = '0x4444444444444444444444444444444444444444';
export const otherJuror = '0x5555555555555555555555555555555555555555';
export const block = 7654321n;
const moduleAddress = '0x6666666666666666666666666666666666666666';
const eligibilityAddress = '0x7777777777777777777777777777777777777777';
const strategyAddress = '0x8888888888888888888888888888888888888888';
const stakeBlockHash = ('0x' + 'a5'.repeat(32)) as Hex;
const unit = 10n ** 18n;
export const dispute = BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [adapter, 0n])));
export const profile = parseProfile({ HONEY_WEB_CHAIN_ID: '31337', FORK_RPC_URL: 'http://127.0.0.1:18545/',
  GARDENS_SUBGRAPH_URL: 'https://private-marker.invalid/index', HONEY_WEB_ADAPTER: adapter, HONEY_WEB_ADAPTER_FROM_BLOCK: String(block - 10n) });

const records = [
  { number: '21', type: 'Proposal', title: 'Orchard maintenance grant', status: 'Disputed' },
  { number: '0', type: 'Decision', title: 'Adopt the summer meeting schedule', status: 'Active' },
  { number: '20', type: 'Suggestion', title: 'Publish the stewardship notes', status: 'Active' },
  { number: '19', type: 'Proposal', title: 'Fund a soil survey', status: 'Executed' },
  { number: '18', type: 'Proposal', title: 'Restore the community tool shed', status: 'Active' },
  { number: '17', type: 'Proposal', title: 'Replace the orchard water pump', status: 'Cancelled' },
  { number: '16', type: 'Suggestion', title: 'Host a seed exchange', status: 'Active' },
  { number: '15', type: 'Proposal', title: 'Support the autumn workshop', status: 'Executed' },
  { number: '14', type: 'Proposal', title: 'Maintain the public seed bank', status: 'Executed' },
  { number: '13', type: 'Proposal', title: 'Order a community rain gauge', status: 'Active' }
];
const setting = parseAbi(['function getSetting(uint256) view returns (address,address,string,bytes)']);
export function fixture(options: { chain?: number; linked?: boolean; failCore?: boolean; ruled?: boolean; badIndex?: boolean; noCases?: boolean; empty?: boolean; hidden?: boolean; paused?: boolean; badReverse?: boolean; badOwner?: boolean; evidenceFails?: boolean; ballotFails?: boolean; appeal?: 'known' | 'other-token'; appealTime?: bigint; roundCount?: bigint; escalation?: 'waiting' | 'expired' | 'underfunded'; partyEvidence?: boolean; challenge?: boolean; zeroAllowance?: boolean; stakePhase?: 0 | 2 } = {}) {
  const escalationCalls: { from: string; actionId: bigint; finished: boolean }[] = [];
  const evidenceCalls: { from: string; disputeId: bigint; reference: string; finished: boolean }[] = [];
  const challenges: { from: string; actionId: bigint; offer: bigint; finished: boolean; context: string }[] = [];
  const ballots: Parameters<JuryDeps['simulateBallot']>[] = [];
  const calls: { method: string; tag?: string; to?: string }[] = [];
  const abis: Record<string, Abi> = {
    [ONEHIVE.CONVICTION_VOTING]: convictionVotingAbi, [ONEHIVE.DISPUTABLE_VOTING]: disputableVotingAbi,
    [ONEHIVE.AGREEMENT]: [...agreementAbi, ...setting, ...parseAbi(['function canPerformChallenge(uint256,address) view returns (bool)'])],
    [adapter]: [...adapterAbi, ...parseAbi(['function getDisputeFees() view returns (address,address,uint256)'])], [core]: [...coreAbi, ...parseAbi([
      'function appealPeriod(uint256) view returns (uint256,uint256)', 'function getDisputeFeeToken(uint256) view returns (address)',
      'function appealCostInFeeToken(uint256) view returns (uint256)', 'function getCourtAndDisputeKitJumps(uint256) view returns (uint96,uint256,uint256,bool,bool)'])],
    [kit]: [...classicAbi, ...parseAbi(['function currentRuling(uint256) view returns (uint256,bool,bool)', 'function getFundedChoices(uint256) view returns (uint256[])',
      'function WINNER_STAKE_MULTIPLIER() view returns (uint256)', 'function LOSER_STAKE_MULTIPLIER() view returns (uint256)',
      'function LOSER_APPEAL_PERIOD_MULTIPLIER() view returns (uint256)'])],
    [TOKENS.HNY.toLowerCase()]: erc20Abi, [moduleAddress]: sortitionAbi, [eligibilityAddress]: eligibilityAbi, [strategyAddress]: strategyAbi
  };
  async function rpc(method: string, params: unknown[]) {
    const [tx, tag] = params as [{ to: string; data: Hex; from?: string }, string?];
    calls.push({ method, ...(tag ? { tag } : {}), ...(tx?.to ? { to: tx.to } : {}) });
    if (method === 'eth_chainId') return '0x' + (options.chain ?? 31337).toString(16);
    if (method === 'eth_blockNumber') return '0x' + block.toString(16);
    if (method === 'eth_getCode') return '0x1234';
    if (method === 'eth_estimateGas' && tx.from === actor) return '0xd431';
    if (method !== 'eth_call') throw new Error('Unexpected method');
    const to = tx.to.toLowerCase();
    const abi = abis[to];
    if (!abi) throw new Error('Unknown fixture contract');
    const { functionName, args } = decodeFunctionData({ abi, data: tx.data });
    function result(value: unknown) { return encodeFunctionResult({ abi: abi!, functionName, result: value }); }
    if (options.partyEvidence && functionName === 'submitEvidence' && to === ONEHIVE.AGREEMENT.toLowerCase() &&
        (tx.from === actor || tx.from === otherJuror) && args?.[0] === dispute && typeof args[1] === 'string' && args[2] === false) {
      evidenceCalls.push({ from: tx.from, disputeId: dispute, reference: args[1], finished: false });
      return '0x';
    }
    if (options.appeal) {
      if (functionName === 'appealPeriod') return result([100n,201n]);
      if (functionName === 'currentRuling') return result([1n,false,false]);
      if (functionName === 'getFundedChoices') return result([2n]);
      if (functionName === 'WINNER_STAKE_MULTIPLIER') return result(10000n);
      if (functionName === 'LOSER_APPEAL_PERIOD_MULTIPLIER') return result(5000n);
      if (functionName === 'LOSER_STAKE_MULTIPLIER') return result(20000n);
      if (functionName === 'getDisputeFeeToken') return result(options.appeal === 'known' ? TOKENS.HNY : actor);
      if (functionName === 'getCourtAndDisputeKitJumps') return result([5n,1n,7n,false,false]);
      if (functionName === 'appealCostInFeeToken') return result(2n * unit);
    }
    if (options.escalation) {
      if (functionName === 'getChallengeArbitratorFees' && args?.[0] === 7n) return result([zeroAddress, 0n, TOKENS.HNY, 2n * unit]);
      if (functionName === 'canDispute') return result(args?.[0] === 121n && options.escalation !== 'expired');
      if (functionName === 'allowance' && String(args?.[1]).toLowerCase() === ONEHIVE.AGREEMENT.toLowerCase())
        return result(options.escalation === 'underfunded' ? 3n * unit - 1n : 75n * unit);
      if (functionName === 'disputeAction' && tx.from === otherJuror && args?.[0] === 121n && args[1] === false) {
        escalationCalls.push({ from: tx.from, actionId: args[0], finished: false });
        return '0x';
      }
    }
    if (options.challenge || options.escalation) {
      const [first, second, finished, context] = args ?? [];
      if (functionName === 'getCollateralRequirement' && second === 7n) return result([TOKENS.HNY, 3600n, 10n * unit, 4n * unit]);
      if (functionName === 'canChallenge') return result(first === 81n || first === 120n);
      if (functionName === 'canPerformChallenge') return result((first === 81n || first === 120n) && second === actor);
      if (functionName === 'getDisputeFees') return result([adapter, TOKENS.HNY, (options.escalation ? 3n : 2n) * unit]);
      if (functionName === 'allowance' && String(second).toLowerCase() === ONEHIVE.AGREEMENT.toLowerCase()) return result(75n * unit);
      if (functionName === 'challengeAction' && to === ONEHIVE.AGREEMENT.toLowerCase() && tx.from === actor &&
          (first === 81n || first === 120n) && typeof second === 'bigint' && finished === false && typeof context === 'string') {
        challenges.push({ from: actor, actionId: first, offer: second, finished, context });
        return '0x';
      }
    }
    if (options.stakePhase !== undefined) {
      if (functionName === 'honey' || functionName === 'pinakion') return result(TOKENS.HNY);
      if (functionName === 'sortitionModule') return result(moduleAddress);
      if (functionName === 'courts' && args?.[0] === 1n) return result([0n, unit, 1000n, unit, eligibilityAddress]);
      if (functionName === 'jurorNft') return result(zeroAddress);
      if (functionName === 'paused') return result(false);
      if (functionName === 'isEligible') return result(args?.[0] === actor && args?.[1] === 1n);
      if (functionName === 'getJurorBalance' && args?.[0] === actor && args?.[1] === 1n) return result([50n * unit, 12n * unit, 50n * unit, 1n]);
      if (functionName === 'stakeWeightStrategy') return result(strategyAddress);
      if (functionName === 'usesIdentityWeight') return result(true);
      if (functionName === 'identityOf' || functionName === 'stakeIdentityOfWallet') return result(actor);
      if (functionName === 'maxStakePerJuror' || functionName === 'maxTotalStaked') return result(100000n * unit);
      if (functionName === 'totalStaked') return result(50n * unit);
      if (functionName === 'phase') return result(options.stakePhase);
      if (functionName === 'decimals') return result(18);
      if (functionName === 'balanceOf') return result(80n * unit);
      if (functionName === 'allowance' && args?.[0] === actor && args?.[1] === core) return result(options.zeroAllowance ? 0n : 75n * unit);
      if (functionName === 'approve' && tx.from === actor && to === TOKENS.HNY.toLowerCase() && args?.[0] === core &&
          typeof args[1] === 'bigint' && (options.zeroAllowance ? args[1] > 0n && args[1] <= 80n * unit : args[1] === 0n)) return result(true);
      if (functionName === 'setStake' && tx.from === actor && to === core && args?.[0] === 1n) return '0x';
    }
    const id = BigInt(String(args?.[0] ?? 0));
    if (functionName === 'getProposal' && id >= 13n && id <= 21n) {
      const status = id === 21n && !options.noCases ? 1 : id === 19n || id === 15n || id === 14n ? 3 : id === 17n ? 2 : 0;
      return result([10n ** 20n, true, actor, 25n * 10n ** 18n, 800n, block - 10n, id + 100n, status, actor, 945n]);
    }
    if (to === ONEHIVE.DISPUTABLE_VOTING && id === 0n) {
      if (functionName === 'canVote') return result(args?.[1] === actor);
      if (functionName === 'getCastVote') return result([0, zeroAddress]);
      if (functionName === 'vote' && tx.from === actor && typeof args?.[1] === 'boolean') return '0x';
    }
    if (functionName === 'getVote' && id === 0n) return result([300n, 50n, 1000n, 100n, block - 5n, 0, 2n, 81n, 0n, 0n, 0n, 0, '0x' + '00'.repeat(32)]);
    if (functionName === 'getSetting' && to === ONEHIVE.DISPUTABLE_VOTING) return result([100n, 500n, 300n, 0n, 0n, 0n, 40n]);
    if (functionName === 'canExecute') return result(false);
    if (functionName === 'isVoteOpenForVoting') return result(true);
    if (functionName === 'getCurrentSettingId') return result(1n);
    if (functionName === 'getSetting') return result([adapter, zeroAddress, 'Fixture covenant', '0x']);
    if (functionName === 'getAction') {
      const challenged = id === 121n && !options.noCases;
      const app = id === 81n ? ONEHIVE.DISPUTABLE_VOTING : ONEHIVE.CONVICTION_VOTING;
      return result([app, options.linked === false ? 999n : id === 81n ? 0n : id - 100n,
        7n, 1n, (options.challenge && (id === 81n || id === 120n)) || ((options.partyEvidence || options.escalation) && id === 121n) ? otherJuror : actor, false, '0x', challenged ? 7n : 0n, challenged]);
    }
    if (functionName === 'getChallenge' && id === 7n && options.escalation)
      return result([121n, actor, options.escalation === 'expired' ? 1760000000n : 1760003600n, '0x', unit, 0, false, false, 0n, 0n]);
    if (functionName === 'getChallenge' && id === 7n) return result([121n, actor, 123n, '0x', 0n, 2, !options.partyEvidence, !options.partyEvidence, dispute, 0n]);
    if (functionName === 'agreement') return result(ONEHIVE.AGREEMENT);
    if (functionName === 'core') return result(core);
    if (functionName === 'disputes' && to === adapter && id === dispute) return result([0n, options.ruled ? 3n : 0n, true, options.ruled ?? false]);
    if (functionName === 'disputes' && to === core && id === 0n && !options.failCore) return result([5n, adapter, options.ruled ? 4 : options.partyEvidence ? 0 : options.appeal ? 3 : 2, !!options.ruled, options.appeal ? 100n : 3n]);
    if (functionName === 'agreementDisputeByCore' && id === 0n) return result(options.badReverse ? 1n : dispute);
    if (functionName === 'getNumberOfRounds' && id === 0n) return result(options.roundCount ?? 1n);
    if (functionName === 'getRoundInfo' && id === 0n && args?.[1] === 0n) return result({
      disputeKitID: 1n, pnkAtStakePerJuror: 50n, totalFeesForJurors: 100n, nbVotes: 3n,
      repartitions: 0n, pnkPenalties: 0n, drawnJurors: [actor, otherJuror, actor], drawnJurorFromCourtIDs: [5n,5n,5n],
      sumFeeRewardPaid: 0n, sumPnkRewardPaid: 0n, feeToken: options.appeal === 'other-token' ? actor : TOKENS.HNY, drawIterations: 3n, courtParamsIndex: 0n,
      __gap: Array(10).fill(0n) });
    if (functionName === 'getAdditionalCourtParams' && id === 5n) return result({
      hiddenVotes: options.hidden ?? false, jurorsForCourtJump: 5n, timesPerPeriod: [120n,120n,120n,120n] });
    if (functionName === 'disputeKits' && id === 1n) return result(kit);
    if (functionName === 'arbitrationPaused') return result(options.paused ?? false);
    if (functionName === 'coreDisputeIDToActive' && id === 0n) return result([true, true]);
    if (functionName === 'getVoteInfo' && id === 0n && args?.[1] === 0n) {
      const seat = args?.[2];
      return result([options.badOwner || seat === 1n ? otherJuror : actor, '0x' + '00'.repeat(32),
        seat === 2n ? 1n : 0n, seat === 2n]);
    }
    throw new Error('private-marker.invalid unavailable');
  }
  const client = createViemChainClient({ chainId: 31337, rpcUrl: profile.rpcUrl,
    transport: custom({ request: async ({ method, params }) => {
      if (method === 'eth_call' && params?.[0]?.from === actor && params[0].data?.startsWith('0x4ef4d13f')) {
        calls.push({ method }); return '0x';
      }
      return rpc(method, params || []);
    } }, { retryCount: 0 }) });
  async function index(params: GardenProposalsParams): Promise<{ data: GardenProposalSummary[]; warnings: string[]; indexBlock: string }> {
    if (options.badIndex) throw new Error(profile.rpcUrl);
    const matching = options.empty ? [] : records.filter(r => params.types?.includes(r.type.toLowerCase()) && (!params.statuses || params.statuses.includes(r.status.toLowerCase())));
    return { indexBlock: String(block - 9n), data: matching.slice(params.skip, (params.skip ?? 0) + (params.first ?? 8)).map(r => ({ id: r.type + r.number, ...r })), warnings: [] };
  }
  const jury: JuryDeps = {
    async evidence(a, id, start, end) {
      if (options.evidenceFails || a !== adapter || id !== dispute || start !== block - 10n || end !== block) throw new Error();
      const transactionHash = ('0x' + 'a5'.repeat(32)) as Hex;
      return [
        { args: { submitter: actor, evidence: stringToHex('ipfs://demo-evidence') }, blockNumber: block - 1n, transactionHash },
        { args: { submitter: otherJuror, evidence: stringToHex('ipfs://demo-challenge') }, blockNumber: block, transactionHash }
      ];
    },
    async simulateBallot(...input) {
      ballots.push(input);
      if (options.ballotFails) throw new Error();
    }
  };
  const stake: StakeDeps = {
    async chain() { return options.chain ?? 31337; },
    async block() { return { hash: stakeBlockHash, number: block, timestamp: options.appeal ? options.appealTime ?? 150n : 1760000000n }; },
    async call(tx, hash) {
      if (options.stakePhase === undefined || hash !== stakeBlockHash) throw new Error('Unexpected stake snapshot.');
      return await rpc('eth_call', [tx, hash]) as Hex;
    },
  };
  return { client, index, calls, rpc, jury, ballots, challenges, evidenceCalls, escalationCalls, ...(options.stakePhase === undefined ? {} : { stake }) };
}
