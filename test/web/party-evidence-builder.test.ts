import { describe, expect, it } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, stringToHex } from 'viem';
import { coreAbi } from '../../src/kleros-court/abis.js';
import { queryPartyEvidence } from '../../src/web/party-evidence.js';
import { actor, core, adapter, dispute, fixture, otherJuror, profile } from '../../examples/governance/fixture.js';

const request = { kind:'proposals', id:'21', account:actor } as const;
const reference = 'Public exhibit 42';
const setup = (options: Parameters<typeof fixture>[0] = {}) => fixture({partyEvidence:true, stakePhase:0, ...options});
describe('party evidence canonical Agreement simulation', () => {
  it.each([[actor,'challenger'],[otherJuror,'submitter']] as const)('projects role for %s, without echoing the reference', async (account,role) => {
    const f = setup(), input = {...request,account}, rpc = f.stake!;
    const quote = await queryPartyEvidence(profile,input,rpc);
    expect(quote).toEqual({...input,actionId:'121',blockHash:(await rpc.block()).hash,period:'evidence',role});
    expect(f.evidenceCalls).toEqual([]);
    expect(await queryPartyEvidence(profile,{...input,blockHash:quote.blockHash,reference},rpc)).toEqual({
      ...quote,byteLength:Buffer.byteLength(reference),submitted:false});
    expect(f.evidenceCalls).toEqual([{from:account,disputeId:dispute,reference:stringToHex(reference),finished:false}]);
  });

  it.each([3,4])('allows unruled later period %s; requires exact empty success return', async period => {
    const f = setup(), rpc = f.stake!;
    const call: typeof rpc.call = async (tx,hash) => {
      if (tx.to === core && decodeFunctionData({abi:coreAbi,data:tx.data}).functionName === 'disputes')
        return encodeFunctionResult({abi:coreAbi,functionName:'disputes',result:[1n,adapter,period,false,3n]});
      return rpc.call(tx,hash);
    };
    const q = await queryPartyEvidence(profile,request,{...rpc,call});
    expect(q.period).toBe(period === 3 ? 'appeal' : 'execution');
    const input = {...request,blockHash:q.blockHash,reference};
    await expect(queryPartyEvidence(profile,input,{...rpc,call})).resolves.toMatchObject({submitted:false});
    await expect(queryPartyEvidence(profile,input,{...rpc,call:(tx,h)=> tx.from ? Promise.resolve('0x01') : call(tx,h)})).rejects.toMatchObject({code:'simulation'});
  });

  it.each([{badReverse:true},{ruled:true},{linked:false},{noCases:true}])('refuses unproven binding or finality %o', async options => {
    const f = setup(options);
    await expect(queryPartyEvidence(profile,request,f.stake!)).rejects.toMatchObject({code:'evidence-not-ready'});
    expect(f.evidenceCalls).toEqual([]);
  });

  it('rejects bystanders, wrong chain, non-local profiles and stale reference previews', async () => {
    const f = setup(), rpc = f.stake!;
    await expect(queryPartyEvidence(profile,{...request,account:core},rpc)).rejects.toMatchObject({code:'evidence-not-ready'});
    await expect(queryPartyEvidence(profile,request,{...rpc,chain:async()=>100})).rejects.toMatchObject({code:'wrong-chain'});
    await expect(queryPartyEvidence({...profile,jurySimulation:false},request,rpc)).rejects.toMatchObject({code:'evidence-not-ready'});
    await expect(queryPartyEvidence(profile,{...request,blockHash:'0x'+ '00'.repeat(32),reference},rpc)).rejects.toMatchObject({code:'evidence-stale'});
    expect(f.evidenceCalls).toEqual([]);
  });
});
