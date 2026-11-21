import { maxUint256, zeroAddress, type Address } from 'viem';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { coreAbi, eligibilityAbi, sortitionAbi, strategyAbi } from './abis.js';
import type { JurorOrPhaseCommand } from './commands.js';
import { preview, sortitionAddress } from './preview.js';
import { requireThat, type Snapshot } from './snapshot.js';

type Stake = Extract<JurorOrPhaseCommand, { targetRaw: bigint }>;

function checkIdentity(s: Snapshot, r: Stake, module: Address, fullyExited: boolean) {
  const strategy = s.read(sortitionAbi, module, 'stakeWeightStrategy', []);
  requireThat(strategy !== zeroAddress, 'Honey stake weight strategy is unconfigured.');
  let court = r.courtId;
  while (!s.read(strategyAbi, strategy, 'usesIdentityWeight', [court])) {
    if (court === 1n) return;
    const [parent] = s.read(coreAbi, r.core, 'courts', [court]);
    requireThat(parent > 0n && parent < court, 'Invalid court ancestry.');
    court = parent;
  }
  const identity = s.read(strategyAbi, strategy, 'identityOf', [r.from]);
  const bound = s.read(sortitionAbi, module, 'stakeIdentityOfWallet', [r.from]);
  requireThat(identity !== zeroAddress && (bound === zeroAddress || bound === identity || fullyExited),
    'Stake increase requires an eligible identity compatible with this wallet’s existing stake and locks.');
}

function stake(s: Snapshot, r: Stake, module: Address) {
  requireThat(!s.read(coreAbi, r.core, 'paused', []), 'Core asset operations are paused.');
  const nft = s.read(coreAbi, r.core, 'jurorNft', []);
  // ERC-721 and ERC-20 share the balanceOf(address) read signature.
  requireThat(nft === zeroAddress || s.read(erc20Abi, nft, 'balanceOf', [r.from]) > 0n, 'Juror NFT required.');
  const [, minStake, , , eligibility] = s.read(coreAbi, r.core, 'courts', [r.courtId]);
  const [total, locked, current, count] = s.read(sortitionAbi, module, 'getJurorBalance', [r.from, r.courtId]);
  const delta = r.targetRaw - current;
  requireThat(current !== 0n || r.targetRaw !== 0n, 'No stake to exit in this court.');
  requireThat(r.targetRaw === 0n || r.targetRaw >= minStake, 'Target below court minimum.');
  if (delta > 0n) {
    requireThat(current !== 0n || count < 4n, 'Wallet has reached the maximum number of court paths.');
    requireThat(eligibility === zeroAddress || s.read(eligibilityAbi, eligibility, 'isEligible', [r.from, r.courtId]),
      'Wallet is ineligible for this court.');
    checkIdentity(s, r, module, count === 0n && total === 0n && locked === 0n);
    const max = s.read(sortitionAbi, module, 'maxStakePerJuror', []);
    requireThat(total + delta <= max && r.targetRaw <= max, 'Juror stake cap exceeded.');
    requireThat(s.read(sortitionAbi, module, 'totalStaked', []) + delta <= s.read(sortitionAbi, module, 'maxTotalStaked', []),
      'Total stake cap exceeded.');
    requireThat(s.read(erc20Abi, r.honey, 'balanceOf', [r.from]) >= delta, 'Insufficient Honey balance for stake increase.');
    const allowance = s.read(erc20Abi, r.honey, 'allowance', [r.from, r.core]);
    if (r.command === 'approve-stake') {
      requireThat(allowance < delta, 'Existing Core allowance covers the stake increase.');
      requireThat(allowance === 0n, 'Clear the existing Core allowance before replacing it.');
      requireThat(delta < maxUint256, 'Unlimited stake approval is unsupported.');
      return { preview: preview(r, 'Honey', r.honey, erc20Abi, 'approve', [r.core, delta],
        `Allow Core to spend exactly ${delta} raw HNY for this wallet’s stake increase.`) };
    }
    requireThat(allowance >= delta, 'Insufficient Honey allowance to Core.');
  }
  requireThat(r.command === 'stake', 'Approval requires a stake increase.');
  const phase = s.read(sortitionAbi, module, 'phase', []);
  requireThat(phase <= 2, 'Unknown sortition phase.');
  const delivery = phase === 0 ? 'immediate' : 'delayed';
  return { delivery, previousStakeRaw: current.toString(), totalLockedRaw: locked.toString(),
    preview: preview(r, 'KlerosCore', r.core, coreAbi, 'setStake', [r.courtId, r.targetRaw],
      `Set court ${r.courtId} stake to a total of ${r.targetRaw} raw HNY. Recorded phase implies ${delivery} processing. Locked Honey can remain after exit.`) };
}

export function planStaking(s: Snapshot, r: JurorOrPhaseCommand) {
  if (r.command === 'clear-stake-allowance') {
    requireThat(s.read(erc20Abi, r.honey, 'allowance', [r.from, r.core]) > 0n, 'Core allowance is already zero.');
    return { preview: preview(r, 'Honey', r.honey, erc20Abi, 'approve', [r.core, 0n], 'Clear this wallet’s Honey allowance to Core.') };
  }
  const module = sortitionAddress(s, r);
  switch (r.command) {
    case 'approve-stake':
    case 'stake':
      return stake(s, r, module);
    case 'withdraw-leftover': {
      requireThat(!s.read(coreAbi, r.core, 'paused', []), 'Core asset operations are paused.');
      const raw = s.read(sortitionAbi, module, 'getJurorLeftoverPNK', [r.beneficiary]);
      requireThat(raw > 0n, 'No unlocked leftover stake for this beneficiary.');
      return { amountRaw: raw.toString(), preview: preview(r, 'SortitionModule', module, sortitionAbi, 'withdrawLeftoverPNK',
        [r.beneficiary], `Release ${raw} raw HNY to the fully exited juror ${r.beneficiary}.`) };
    }
    case 'execute-delayed-stakes': {
      requireThat(!s.read(coreAbi, r.core, 'paused', []), 'Queued asset transfers are outside preview scope while Core is paused.');
      requireThat(s.read(sortitionAbi, module, 'phase', []) === 0, 'Delayed stakes require the staking phase.');
      const first = s.read(sortitionAbi, module, 'delayedStakeReadIndex', []);
      const last = s.read(sortitionAbi, module, 'delayedStakeWriteIndex', []);
      requireThat(first > 0n && first <= last, 'No initialized, nonempty stake queue.');
      requireThat(first + r.iterations <= maxUint256, 'Queue iteration count would overflow.');
      return { preview: preview(r, 'SortitionModule', module, sortitionAbi, 'executeDelayedStakes', [r.iterations],
        `Process up to ${r.iterations} queued stake changes. Individual changes may fail and be removed from the queue.`) };
    }
    case 'pass-phase': {
      const phase = s.read(sortitionAbi, module, 'phase', []);
      requireThat(['staking', 'generating', 'drawing'][phase] === r.phase, 'Recorded phase differs from requested phase.');
      const rng = r.phase === 'drawing' ? null : s.read(sortitionAbi, module, 'rng', []);
      requireThat(rng !== zeroAddress, 'No RNG is configured.');
      if (r.phase !== 'generating') {
        const pending = s.read(sortitionAbi, module, 'disputesWithoutJurors', []);
        const elapsed = BigInt(s.block.timestamp) - s.read(sortitionAbi, module, 'lastPhaseChange', []);
        requireThat(elapsed >= 0n, 'Phase start is after the recording timestamp.');
        if (r.phase === 'staking') {
          requireThat(pending > 0n && elapsed >= s.read(sortitionAbi, module, 'minStakingTime', []),
            'Generating requires a pending draw and elapsed minimum staking time.');
        } else {
          requireThat(pending === 0n || elapsed >= s.read(sortitionAbi, module, 'maxDrawingTime', []),
            'Outstanding draws and unelapsed drawing timeout.');
        }
      }
      return { rng, preview: preview(r, 'SortitionModule', module, sortitionAbi, 'passPhase', [],
        r.phase === 'generating' ? 'Advance generating to drawing if the RNG returns a nonzero number. RNG readiness is unverified.' :
          `Advance the global sortition phase from ${r.phase}. This affects all pending draws.`) };
    }
  }
}
