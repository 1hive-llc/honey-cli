import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, zeroAddress, type Abi, type Address } from 'viem';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import { adapterAbi } from '../../src/onehive/tools/kleros.js';
import { queryEscalation, type EscalationQuote } from '../../src/web/escalation.js';
import type { StakeDeps } from '../../src/web/stake.js';
import { actor, adapter, fixture, otherJuror, profile } from '../../examples/governance/fixture.js';

const req = {kind:'proposals',id:'21',account:otherJuror} as const;
function setup(changes: Record<string,unknown> = {}, timestamp = 100n) {
  const f = fixture({stakePhase:0,partyEvidence:true}), base = f.stake!;
  const expectedHash = '0x'+'a5'.repeat(32);
  const results = {getChallenge:[121n,actor,101n,'0x',20n,0,false,false,0n,0n],
    getChallengeArbitratorFees:[zeroAddress,0n,TOKENS.HNY,2n], getDisputeFees:[adapter,TOKENS.HNY,3n],
    canDispute:true, allowance:3n, balanceOf:4n, ...changes} as Record<string,unknown>;
  const signedCalls: {to:Address; from:Address; args:readonly unknown[]}[] = [];
  const rpc: StakeDeps = {...base, block:async()=>({...await base.block(),timestamp}), async call(tx, hash) {
    expect(hash).toBe(expectedHash);
    const abi: Abi = tx.to.toLowerCase() === ONEHIVE.AGREEMENT.toLowerCase() ? agreementAbi :
      tx.to === adapter ? adapterAbi : tx.to.toLowerCase() === TOKENS.HNY.toLowerCase() ? erc20Abi : [];
    let decoded;
    try { decoded = decodeFunctionData({abi,data:tx.data}); } catch { return base.call(tx, hash); }
    const {functionName,args} = decoded;
    if (tx.from) {
      if (functionName !== 'disputeAction') throw new Error('unexpected simulation');
      signedCalls.push({to:tx.to,from:tx.from,args:args!}); return '0x';
    }
    if (functionName === 'allowance') expect(args).toEqual([changes.account ?? req.account,expect.stringMatching(new RegExp(ONEHIVE.AGREEMENT,'i'))]);
    if (Object.hasOwn(results,functionName)) return encodeFunctionResult({abi,functionName,result:results[functionName]});
    return base.call(tx, hash);
  }};
  return {rpc,signedCalls};
}

describe('canonical submitter escalation', () => {
  it('keeps recorded challenger fee and freshly priced submitter fee separate; calls Agreement only, no early closure', async () => {
    const {rpc,signedCalls} = setup();
    const quote = await queryEscalation(profile,req,rpc);
    expect(quote).toEqual({...req,actionId:'121',challengeId:'7',deadline:'101',challengerFeeEscrowRaw:'2',submitterFeeRaw:'3',
      allowanceRaw:'3',balanceRaw:'4',eligible:true,blockHash:(await rpc.block()).hash});
    expect(signedCalls).toEqual([]);
    await expect(queryEscalation(profile,{...req,blockHash:quote.blockHash},rpc)).resolves.toEqual({...quote,submitted:false});
    expect(signedCalls).toEqual([{to:expect.stringMatching(new RegExp(ONEHIVE.AGREEMENT,'i')),from:otherJuror,args:[121n,false]}]);
  });
  it.each([{canDispute:false},{allowance:2n},{balanceOf:2n},{account:actor},{timestamp:101n},{timestamp:102n}])('refuses ineligible case %o', async change => {
    const {rpc,signedCalls} = setup(change, 'timestamp' in change ? change.timestamp : 100n);
    const request: EscalationQuote = {...req,account:'account' in change ? actor : req.account};
    const quote = await queryEscalation(profile,request,rpc);
    expect(quote.eligible).toBe(false);
    await expect(queryEscalation(profile,{...request,blockHash:quote.blockHash},rpc)).rejects.toMatchObject({code:'escalation-not-ready'});
    expect(signedCalls).toEqual([]);
  });
  it.each([{getChallenge:[100n,actor,101n,'0x',0n,0,false,false,0n,0n]},
    {getChallenge:[121n,actor,101n,'0x',0n,2,false,false,5n,0n]},
    {getChallengeArbitratorFees:[zeroAddress,0n,actor,2n]}, {getDisputeFees:[actor,TOKENS.HNY,3n]}])('fails closed on incoherent link/fee %o', async change => {
    await expect(queryEscalation(profile,req,setup(change).rpc)).rejects.toMatchObject({code:'escalation-not-ready'});
  });
  it('refuses stale and wrong-chain requests, and redacts simulation failure', async () => {
    const {rpc} = setup();
    await expect(queryEscalation(profile,{...req,blockHash:'0x00'},rpc)).rejects.toMatchObject({code:'escalation-stale'});
    await expect(queryEscalation(profile,req,{...rpc,chain:async()=>100})).rejects.toMatchObject({code:'wrong-chain'});
    const q = await queryEscalation(profile,req,rpc);
    await expect(queryEscalation(profile,{...req,blockHash:q.blockHash},{...rpc,call:(tx,h)=>tx.from ? Promise.reject(Error('upstream')) : rpc.call(tx,h)}))
      .rejects.toMatchObject({message:'simulation'});
  });
});
