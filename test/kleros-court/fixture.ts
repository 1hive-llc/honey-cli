import { encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, zeroAddress,
  type Abi, type Address, type Hex } from 'viem';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { agreementAbi, agreementResolutionAbi } from '../../src/onehive/abis/agreement.js';
import { adapterAbi, classicAbi, coreAbi, sortitionAbi, strategyAbi } from '../../src/kleros-court/abis.js';
import { runCourtCommand } from '../../src/kleros-court/run.js';

const addr = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`);
export const [core, honey, module, classic, adapter, agreement, app, juror, operator, other, strategy, identity] =
  [200, 201, 202, 203, 204, 205, 206, 207, 208, 209, 210, 211].map(addr) as
  [Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address, Address];
export const base = { chainId: 31337, core, honey, from: juror };
export const caseRequest = { ...base, adapter, agreement, classic, challengeId: '18', roundId: '0' };
export const coreId = 9007199254741009n;
export function agreementId(id: bigint) {
  return BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [adapter, id])));
}
const challenger = addr(212);
export const submitter = addr(213);
const zeroHash = ('0x' + '00'.repeat(32)) as Hex;

// Synthetic public responses. Replacement is by exact target/calldata, as in a real recording.
export class Recording {
  calls = new Map<string, { to: Address; data: Hex; result: Hex }>();
  timestamp = '150';
  set(to: Address, abi: Abi, functionName: string, args: readonly unknown[], result: unknown) {
    const data = encodeFunctionData({ abi, functionName, args });
    this.calls.set(to + data, { to, data, result: encodeFunctionResult({ abi, functionName, result }) });
    return this;
  }
  json() {
    return { chainId: 31337, blockNumber: '450', blockHash: '0x' + '12'.repeat(32), timestamp: this.timestamp,
      calls: Array.from(this.calls.values()) };
  }
  run(command: string, fields: Record<string, unknown>) {
    return runCourtCommand({ command, ...fields }, this.json());
  }
}

function common() {
  return new Recording()
    .set(core, coreAbi, 'pinakion', [], honey)
    .set(honey, erc20Abi, 'decimals', [], 18)
    .set(core, coreAbi, 'sortitionModule', [], module)
    .set(module, sortitionAbi, 'core', [], core)
    .set(module, sortitionAbi, 'rng', [], addr(214))
    .set(core, coreAbi, 'paused', [], false)
    .set(core, coreAbi, 'arbitrationPaused', [], false);
}

export function stakingFixture() {
  return common()
    .set(core, coreAbi, 'jurorNft', [], zeroAddress)
    .set(core, coreAbi, 'courts', [1n], [0n, 20n, 1000n, 30n, zeroAddress])
    .set(module, sortitionAbi, 'getJurorBalance', [juror, 1n], [41n, 13n, 41n, 1n])
    .set(module, sortitionAbi, 'stakeWeightStrategy', [], strategy)
    .set(strategy, strategyAbi, 'usesIdentityWeight', [1n], true)
    .set(strategy, strategyAbi, 'identityOf', [juror], identity)
    .set(module, sortitionAbi, 'stakeIdentityOfWallet', [juror], identity)
    .set(module, sortitionAbi, 'totalStaked', [], 700n)
    .set(module, sortitionAbi, 'maxTotalStaked', [], 1000n)
    .set(module, sortitionAbi, 'maxStakePerJuror', [], 500n)
    .set(honey, erc20Abi, 'balanceOf', [juror], 1000n)
    .set(honey, erc20Abi, 'allowance', [juror, core], 59n)
    .set(module, sortitionAbi, 'phase', [], 0);
}

export function caseFixture({ id = coreId, period = 2, finalised = false, ruling = 0n, state = 2,
  hidden = false, drawn = [juror, other, juror], kitId = 1n, feeToken = honey, roundId = 0n, repartitions = 0n } = {}) {
  const aid = agreementId(id);
  const b = common()
    .set(adapter, adapterAbi, 'agreement', [], agreement)
    .set(adapter, adapterAbi, 'honey', [], honey)
    .set(adapter, adapterAbi, 'core', [], core)
    .set(agreement, agreementResolutionAbi, 'getSetting', [5n], [adapter, zeroAddress, 'Synthetic covenant', '0x'])
    .set(agreement, agreementAbi, 'getChallenge', [18n],
      [11n, challenger, 99n, '0x', 0n, state, true, true, aid, state > 2 ? ruling : 0n])
    .set(agreement, agreementAbi, 'getAction', [11n], [app, 777n, 8n, 5n, submitter, state === 4, '0x', 18n, state === 2])
    .set(agreement, agreementAbi, 'getChallengeArbitratorFees', [18n], [honey, 75n, honey, 67n])
    .set(agreement, agreementAbi, 'getCollateralRequirement', [app, 8n], [honey, 86400n, 100n, 200n])
    .set(adapter, adapterAbi, 'agreementDisputeByCore', [id], aid)
    .set(adapter, adapterAbi, 'disputes', [aid], [id, ruling, true, finalised])
    .set(core, coreAbi, 'disputes', [id], [1n, adapter, period, finalised, 100n])
    .set(core, coreAbi, 'getNumberOfRounds', [id], roundId + 1n)
    .set(core, coreAbi, 'getRoundInfo', [id, roundId], { disputeKitID: kitId, pnkAtStakePerJuror: 15n,
      totalFeesForJurors: 75n, nbVotes: 3n, repartitions, pnkPenalties: 0n, drawnJurors: drawn,
      drawnJurorFromCourtIDs: drawn.map(() => 1n), sumFeeRewardPaid: 0n, sumPnkRewardPaid: 0n,
      feeToken, drawIterations: BigInt(drawn.length), courtParamsIndex: 5n, __gap: Array(10).fill(0n) })
    .set(core, coreAbi, 'getAdditionalCourtParams', [1n, 5n], { hiddenVotes: hidden, jurorsForCourtJump: 30n,
      timesPerPeriod: [50n, 50n, 50n, 50n] })
    .set(core, coreAbi, 'disputeKits', [1n], classic)
    .set(classic, classicAbi, 'core', [], core)
    .set(classic, classicAbi, 'coreDisputeIDToActive', [id], [true, true])
    .set(core, coreAbi, 'arbitrationPauseGracePeriodEnd', [], 0n)
    .set(core, coreAbi, 'currentRuling', [id], [finalised ? ruling - 2n : 1n, finalised && ruling === 2n, false])
    .set(classic, classicAbi, 'getCoherentCount', [id, roundId], 1n)
    .set(module, sortitionAbi, 'phase', [], 2);
  drawn.forEach((account, i) => b.set(classic, classicAbi, 'getVoteInfo', [id, roundId, BigInt(i)], [account, zeroHash, 0n, false]));
  return b;
}
