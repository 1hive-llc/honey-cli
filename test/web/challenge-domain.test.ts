import { decodeFunctionData, getAddress, stringToHex, zeroAddress, type Hex } from 'viem';
import { expect, it, vi } from 'vitest';
import { Recording } from '../kleros-court/fixture.js';
import { actor as account, adapter, core, otherJuror, profile } from '../../examples/governance/fixture.js';
import { coreAbi } from '../../src/kleros-court/abis.js';
import { agreementAbi, agreementResolutionAbi } from '../../src/onehive/abis/agreement.js';
import { convictionVotingAbi } from '../../src/onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../../src/onehive/abis/disputableVoting.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import { adapterAbi } from '../../src/onehive/tools/kleros.js';
import { queryChallenge, challengePermissionAbi } from '../../src/web/challenge.js';
import type { Kind } from '../../src/web/profile.js';
import type { StakeDeps } from '../../src/web/stake.js';

const agreement = getAddress(ONEHIVE.AGREEMENT), honey = TOKENS.HNY;
const hash = ('0x' + 'ef'.repeat(32)) as Hex, unit = 10n ** 18n, action = 235n;
const offerHny = '2.000000000000000001', context = 'ipfs://challenge';
function fixture(kind: Kind = 'votes') {
  const app = getAddress(kind === 'votes' ? ONEHIVE.DISPUTABLE_VOTING : ONEHIVE.CONVICTION_VOTING);
  const r = new Recording();
  if (kind === 'votes') r.set(app, disputableVotingAbi, 'getVote', [0n], [0n,0n,1n,0n,0n,0,1n,action,0n,0n,0n,0,hash]);
  else r.set(app, convictionVotingAbi, 'getProposal', [0n], [0n,false,account,0n,0n,0n,action,0,otherJuror,0n]);
  r.set(agreement, agreementAbi, 'getAction', [action], [app,0n,7n,3n,otherJuror,false,'0x',0n,false])
    .set(agreement, agreementResolutionAbi, 'getSetting', [3n], [adapter,zeroAddress,'terms','0x'])
    .set(adapter, adapterAbi, 'core', [], core).set(adapter, adapterAbi, 'agreement', [], agreement)
    .set(adapter, adapterAbi, 'honey', [], honey).set(core, coreAbi, 'pinakion', [], honey)
    .set(honey, erc20Abi, 'decimals', [], 18)
    .set(agreement, agreementAbi, 'getCollateralRequirement', [app,7n], [honey,100n,10n*unit,4n*unit])
    .set(adapter, adapterAbi, 'getDisputeFees', [], [adapter,honey,2n*unit])
    .set(agreement, agreementAbi, 'canChallenge', [action], true)
    .set(agreement, challengePermissionAbi, 'canPerformChallenge', [action,account], true)
    .set(honey, erc20Abi, 'balanceOf', [account], 6n*unit).set(honey, erc20Abi, 'allowance', [account,agreement], 6n*unit);
  const call = vi.fn<StakeDeps['call']>(async (tx, block) => {
    expect(block).toBe(hash);
    if (tx.from) {
      expect([tx.to,tx.from]).toEqual([agreement,account]);
      expect(decodeFunctionData({ abi: agreementAbi, data: tx.data })).toEqual({ functionName: 'challengeAction',
        args: [action, 2n*unit+1n, false, stringToHex(context)] });
      return '0x';
    }
    return r.calls.get(tx.to + tx.data)!.result;
  });
  const rpc = { chain: async () => 31337, block: async () => ({ hash, number: 9n, timestamp: 0n }), call };
  const quote = { kind, id: '0', account } as const, preview = { ...quote, blockHash: hash, offerHny, context };
  return { r, app, rpc, quote, preview };
}

it.each(['proposals','votes'] as const)('simulates %s exact caller→Agreement calldata, excluding the offer from challenger debit', async kind => {
  const { rpc, quote, preview } = fixture(kind);
  expect(await queryChallenge(profile, quote, rpc)).toMatchObject({ eligible: true, actionId: '235', totalDebitRaw: String(6n*unit), blockHash: hash });
  expect(rpc.call.mock.calls.some(([tx]) => tx.from)).toBe(false);
  const result = await queryChallenge(profile, preview, rpc);
  expect(result).toMatchObject({ submitted: false, settlementOfferRaw: String(2n*unit+1n), totalDebitRaw: String(6n*unit) });
  expect(JSON.stringify(result)).not.toMatch(/"data"|"context"|"signature"/);
  expect(rpc.call.mock.calls.filter(([tx]) => tx.from)).toHaveLength(1);
});

it.each(['permission','state','allowance','balance','fee recipient','token','saved setting','local ID','offer','actor simulation'] as const)(
  'rejects a bad %s', async reason => {
    const { r, app, rpc, preview } = fixture();
    switch (reason) {
      case 'permission': r.set(agreement, challengePermissionAbi, 'canPerformChallenge', [action,account], false); break;
      case 'state': r.set(agreement, agreementAbi, 'canChallenge',[action], false); break;
      case 'balance': r.set(honey, erc20Abi, 'balanceOf',[account], 6n*unit-1n); break;
      case 'allowance': r.set(honey, erc20Abi, 'allowance',[account,agreement], 6n*unit-1n); break;
      case 'fee recipient': r.set(adapter, adapterAbi,'getDisputeFees',[],[core,honey,1n]); break;
      case 'token': r.set(adapter, adapterAbi,'getDisputeFees',[],[adapter,core,1n]); break;
      case 'saved setting': r.set(agreement, agreementResolutionAbi,'getSetting',[3n],[core,zeroAddress,'old','0x']); break;
      case 'local ID': r.set(agreement, agreementAbi,'getAction',[action],[app,1n,7n,3n,otherJuror,false,'0x',0n,false]); break;
      case 'offer': preview.offerHny = '11'; break;
      case 'actor simulation': {
        const original = rpc.call.getMockImplementation()!;
        rpc.call.mockImplementation((tx, block) => { if (tx.from) throw new Error('private RPC detail'); return original(tx,block); }); break;
      }
    }
    await expect(queryChallenge(profile, preview, rpc)).rejects.toMatchObject({ code: reason === 'actor simulation' ? 'simulation' : 'challenge-not-ready' });
    expect(rpc.call.mock.calls.filter(([tx]) => tx.from)).toHaveLength(reason === 'actor simulation' ? 1 : 0);
  });

it('rejects remote profiles, stale reviews and sensitive context before sending contract calls', async () => {
  const { rpc, preview } = fixture();
  await expect(queryChallenge({ ...profile, jurySimulation: false }, preview, rpc)).rejects.toMatchObject({ code: 'challenge-not-ready' });
  await expect(queryChallenge(profile, { ...preview, blockHash: '0x' + '01'.repeat(32) }, rpc)).rejects.toMatchObject({ code: 'challenge-stale' });
  await expect(queryChallenge(profile, { ...preview, context: 'seed phrase=redacted' }, rpc)).rejects.toMatchObject({ code: 'challenge-not-ready' });
  expect(rpc.call).not.toHaveBeenCalled();
});
