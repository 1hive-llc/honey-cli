import { getAddress, zeroAddress, type Address, type Hex } from 'viem';
import { erc20Abi } from '../onehive/abis/erc20.js';
import { TOKENS } from '../onehive/addresses.js';
import { adapterAbi, coreAbi, eligibilityAbi, sortitionAbi } from '../kleros-court/abis.js';
import { commands } from '../kleros-court/commands.js';
import { planCourtCommand } from '../kleros-court/run.js';
import { CourtError, MissingRead, Snapshot } from '../kleros-court/snapshot.js';
import { QueryFailure, type Profile } from './profile.js';

export type StakeRead = { account: Address };
export type StakePreview = StakeRead & { target: string; blockHash: string };
export type StakeDeps = {
  chain: () => Promise<number>;
  block: () => Promise<{ hash: Hex | null; number: bigint | null; timestamp: bigint }>;
  call: (call: { from?: Address; to: Address; data: Hex }, hash: Hex) => Promise<Hex>;
};

function view(s: Snapshot, adapter: Address, core: Address, court: bigint, account: Address, canPreview: boolean) {
  const honey = TOKENS.HNY;
  if (s.read(adapterAbi, adapter, 'core', []) !== core || s.read(adapterAbi, adapter, 'honey', []) !== honey ||
      s.read(coreAbi, core, 'pinakion', []) !== honey || s.read(erc20Abi, honey, 'decimals', []) !== 18) {
    throw new QueryFailure('unavailable');
  }
  const module = s.read(coreAbi, core, 'sortitionModule', []);
  if (module === zeroAddress || s.read(sortitionAbi, module, 'core', []) !== core) throw new QueryFailure('unavailable');
  const [, minimum, , , eligibility] = s.read(coreAbi, core, 'courts', [court]);
  if (minimum === 0n || eligibility === zeroAddress) throw new QueryFailure('unavailable');
  const nft = s.read(coreAbi, core, 'jurorNft', []);
  const eligible = s.read(eligibilityAbi, eligibility, 'isEligible', [account, court]) &&
    (nft === zeroAddress || s.read(erc20Abi, nft, 'balanceOf', [account]) > 0n);
  const [total, locked, current] = s.read(sortitionAbi, module, 'getJurorBalance', [account, court]);
  const balance = s.read(erc20Abi, honey, 'balanceOf', [account]);
  const allowance = s.read(erc20Abi, honey, 'allowance', [account, core]);
  return { account, courtId: String(court), blockHash: s.block.blockHash, block: s.block.blockNumber,
    currentStakeRaw: String(current), totalStakeRaw: String(total), totalLockedRaw: String(locked), minimumStakeRaw: String(minimum),
    balanceRaw: String(balance), allowanceRaw: String(allowance), eligible, canPreview };
}

export function stakeTargetRaw(value: string) {
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole + fraction.padEnd(18, '0'));
}

export async function withStakeSnapshot<T>(p: Profile, input: StakeRead & { blockHash?: string }, rpc: StakeDeps,
  evaluate: (current: ReturnType<typeof view>, s: Snapshot, core: Address, courtId: string, account: Address, hash: Hex) => Promise<T>) {
  if (!p.adapter || !p.stake) throw new QueryFailure('stake-not-configured');
  const isPreview = 'mode' in input || 'target' in input;
  if (isPreview && !p.jurySimulation) throw new QueryFailure('stake-not-ready');
  if (await rpc.chain() !== p.chainId) throw new QueryFailure('wrong-chain');
  const { hash, number, timestamp } = await rpc.block();
  if (hash === null || number === null) throw new QueryFailure('unavailable');
  if (isPreview && hash.toLowerCase() !== input.blockHash?.toLowerCase()) throw new QueryFailure('stake-stale');
  const account = getAddress(input.account);
  const { core, courtId } = p.stake;
  const calls: { to: Address; data: Hex; result: Hex }[] = [];
  const recording = { chainId: p.chainId, blockNumber: String(number), blockHash: hash, timestamp: String(timestamp), calls };
  for (;;) {
    try {
      const s = new Snapshot(recording);
      const current = view(s, p.adapter, core, BigInt(courtId), account, p.jurySimulation);
      return await evaluate(current, s, core, courtId, account, hash);
    } catch (error) {
      if (!(error instanceof MissingRead)) {
        if (isPreview && error instanceof CourtError) throw new QueryFailure('stake-not-ready');
        throw error;
      }
      if (calls.length >= 256) throw new QueryFailure('unavailable');
      const { to, data } = error.request;
      calls.push({ to, data, result: await rpc.call({ to, data }, hash) });
    }
  }
}

export async function queryStake(p: Profile, input: StakeRead | StakePreview, rpc: StakeDeps) {
  return withStakeSnapshot(p, input, rpc, async (current, s, core, courtId, account, hash) => {
    if (!('target' in input)) return current;
    const target = stakeTargetRaw(input.target);
    if (String(target) === current.currentStakeRaw) throw new QueryFailure('stake-not-ready');
    const request = commands.parse({ command: 'stake', chainId: p.chainId, core, courtId, honey: TOKENS.HNY, from: account, targetRaw: String(target) });
    const result = planCourtCommand(request, s).data;
    if (!result || !('delivery' in result) || !('previousStakeRaw' in result) || result.previousStakeRaw !== current.currentStakeRaw ||
        !['immediate', 'delayed'].includes(result.delivery) || !('preview' in result) || !result.preview) throw new QueryFailure('stake-not-ready');
    try { await rpc.call({ to: core, from: account, data: result.preview.data }, hash); }
    catch { throw new QueryFailure('simulation'); }
    return { ...current, targetStakeRaw: String(target), delivery: result.delivery, submitted: false };
  });
}
