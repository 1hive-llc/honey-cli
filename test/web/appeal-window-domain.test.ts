import { expect, it } from 'vitest';
import { encodeFunctionData, type Hex } from 'viem';
import { caseFixture, adapter, agreement, app, core, classic, coreId, other, juror } from '../kleros-court/fixture.js';
import { adapterAbi, classicAbi, coreAbi } from '../../src/kleros-court/abis.js';
import { convictionVotingAbi } from '../../src/onehive/abis/convictionVoting.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { TOKENS } from '../../src/onehive/addresses.js';
import { queryAppealWindow, appealReadAbi } from '../../src/web/appeal-window.js';
import { parseProfile } from '../../src/web/profile.js';
import type { StakeDeps } from '../../src/web/stake.js';

const p = parseProfile({ HONEY_WEB_CHAIN_ID:'31337', FORK_RPC_URL:'http://localhost:8545', HONEY_WEB_ADAPTER:adapter,
  ONEHIVE_CONVICTION_VOTING:app, ONEHIVE_AGREEMENT:agreement, HONEY_WEB_APPEAL_KIT:classic });
const input = {kind:'proposals', id:'777'} as const, hash = ('0x'+'a5'.repeat(32)) as Hex;
function setup(now = 150n, partial: Parameters<typeof caseFixture>[0] = {}) {
  const r = caseFixture({period:3,feeToken:TOKENS.HNY,...partial})
    .set(app,convictionVotingAbi,'getProposal',[777n],[0n,false,juror,0n,0n,0n,11n,0,juror,0n])
    .set(core,coreAbi,'pinakion',[],TOKENS.HNY).set(adapter,adapterAbi,'honey',[],TOKENS.HNY)
    .set(core,appealReadAbi,'appealPeriod',[coreId],[100n,201n])
    .set(classic,coreAbi,'currentRuling',[coreId],[1n,false,false])
    .set(classic,appealReadAbi,'getFundedChoices',[coreId],[2n])
    .set(classic,appealReadAbi,'WINNER_STAKE_MULTIPLIER',[],10000n)
    .set(classic,appealReadAbi,'LOSER_STAKE_MULTIPLIER',[],20000n)
    .set(classic,appealReadAbi,'LOSER_APPEAL_PERIOD_MULTIPLIER',[],5000n)
    .set(core,appealReadAbi,'getDisputeFeeToken',[coreId],TOKENS.HNY)
    .set(TOKENS.HNY,erc20Abi,'decimals',[],18)
    .set(core,appealReadAbi,'getCourtAndDisputeKitJumps',[coreId],[1n,1n,7n,false,false])
    .set(core,appealReadAbi,'appealCostInFeeToken',[coreId],17n);
  const rpc: StakeDeps = { chain:async()=>31337,block:async()=>({hash,number:500n,timestamp:now}),call:async(tx,h)=>{
    expect(h).toBe(hash); expect(tx.from).toBeUndefined(); return r.calls.get(tx.to+tx.data)!.result;
  }};
  return {r,rpc};
}
it('gross HNY targets from the trusted kit; actual funded choice independent of cutoff; exclusive halfway floor',async()=>{
  const v = await queryAppealWindow(p,input,setup().rpc);
  expect(v).toMatchObject({start:'100',end:'201',observedAt:'150',block:'500',feeAsset:'HNY',baseCostRaw:'17',preliminaryChoice:'1',
    choices:[{choice:'0',cutoff:'150',open:false,funded:false,targetRaw:'51'},
      {choice:'1',cutoff:'201',open:true,funded:false,targetRaw:'34'},{choice:'2',cutoff:'150',open:false,funded:true,targetRaw:'51'}]});
});
it('refuse is the apparent winner for a tie; pause disables every window',async()=>{
  const {r,rpc}=setup(149n);
  for(const address of [core,classic]) r.set(address,coreAbi,'currentRuling',[coreId],[0n,true,false]);
  expect((await queryAppealWindow(p,input,rpc)).choices[0]).toMatchObject({cutoff:'201',open:true,targetRaw:'34'});
  r.set(core,coreAbi,'arbitrationPaused',[],true);
  expect((await queryAppealWindow(p,input,rpc)).choices.every(x=>x.open===false)).toBe(true);
});
it.each([undefined,other])('does not infer Honey mechanics from an unauthenticated slot or upstream getters',async pin=>{
  const v=await queryAppealWindow({...p,appealKit:pin},input,setup().rpc);
  expect(v.feeAsset).toBeNull(); expect(v.baseCostRaw).toBeNull();
  expect(v.choices[2]).toEqual({choice:'2',cutoff:null,open:null,targetRaw:null,funded:true});
});
it.each(['initial token','round token','kit jump','forking court','mismatched kit ruling','missing converter'] as const)('withholds quotes on %s',async reason=>{
  const {r,rpc}=setup(100n,reason==='round token'?{feeToken:other}:{});
  if(reason==='initial token')r.set(core,appealReadAbi,'getDisputeFeeToken',[coreId],other);
  if(reason==='kit jump')r.set(core,appealReadAbi,'getCourtAndDisputeKitJumps',[coreId],[1n,2n,7n,false,true]);
  if(reason==='forking court')r.set(core,appealReadAbi,'getCourtAndDisputeKitJumps',[coreId],[0n,1n,7n,true,false]);
  if(reason==='mismatched kit ruling')r.set(classic,coreAbi,'currentRuling',[coreId],[2n,false,false]);
  if(reason==='missing converter')r.calls.delete(core+encodeFunctionData({abi:appealReadAbi,functionName:'appealCostInFeeToken',args:[coreId]}));
  const v=await queryAppealWindow(p,input,rpc);
  expect(v.baseCostRaw).toBeNull();expect(v.choices.every(x=>x.targetRaw===null)).toBe(true);
});
it.each(['unlinked','inactive kit','not appeal','other kit'] as const)('rejects %s without presenting a window',async reason=>{
  const {r,rpc}=setup(150n,reason==='other kit'?{kitId:2n}:reason==='not appeal'?{period:2}:{});
  if(reason==='unlinked')r.set(adapter,adapterAbi,'agreementDisputeByCore',[coreId],0n);
  if(reason==='inactive kit')r.set(classic,classicAbi,'coreDisputeIDToActive',[coreId],[true,false]);
  await expect(queryAppealWindow(p,input,rpc)).rejects.toMatchObject({code:'appeal-not-ready'});
});
