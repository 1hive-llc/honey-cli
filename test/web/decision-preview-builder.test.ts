import { describe, expect, it, vi } from 'vitest';
import type { ChainClient, ContractReadRequest } from '../../src/onehive/clients/chain.js';
import { previewDecisionVote } from '../../src/web/decision-preview.js';
import { actor, profile } from '../../examples/governance/fixture.js';

const input = { id: '0', account: actor, supports: false } as const;
function setup(status = 0, open = true, eligible = true) {
  const simulation = vi.fn(async () => ({ status: 'success' as const }));
  const send = vi.fn(async () => { throw Error('unexpected submission'); });
  const client: ChainClient = { chainId: 31337, rpcUrl: profile.rpcUrl, getChainId: vi.fn(async () => 31337),
    getBlockNumber: async () => 7n, getBytecode: async () => '0x01', estimateGas: async () => 1n,
    simulateContract: simulation, sendTransaction: send,
    async readContract<T>(req: ContractReadRequest) {
      expect(req.blockNumber).toBe(7n);
      const values: Record<string, unknown> = { getVote: [0n,0n,1n,1n,1n,status,0n,0n,0n,0n,0n,0,'0x'],
        getSetting: Array(7).fill(0n), canExecute: false, isVoteOpenForVoting: open, canVote: eligible, getCastVote: [0, actor] };
      return values[req.functionName] as T;
    } };
  return { client, send, simulation };
}

describe('Decision browser projection of the real protocol builder', () => {
  it.each([true,false])('simulates the requested direction (%s), never submitting', async supports => {
    const {client, simulation, send} = setup();
    expect(await previewDecisionVote(profile, {...input, supports}, client)).toEqual({...input, supports, simulation:'success', submitted:false});
    expect(simulation).toHaveBeenCalledWith(expect.objectContaining({account:actor, functionName:'vote', args:[0n,supports]}));
    expect(send).not.toHaveBeenCalled();
  });
  it.each([[1,true,true],[2,true,true],[3,true,true],[0,false,true],[0,true,false]] as const)('refuses status=%i open=%s eligible=%s', async (status, open, eligible) => {
    const {client, simulation} = setup(status,open,eligible);
    await expect(previewDecisionVote(profile,input,client)).rejects.toMatchObject({code:'decision-not-ready'});
    expect(simulation).not.toHaveBeenCalled();
  });
  it('refuses remote profiles before RPC, wrong actual chains before simulation, and reverts without details', async () => {
    const {client, simulation} = setup();
    await expect(previewDecisionVote({...profile,jurySimulation:false},input,client)).rejects.toMatchObject({code:'decision-not-ready'});
    expect(client.getChainId).not.toHaveBeenCalled();
    await expect(previewDecisionVote(profile,input,{...client,getChainId:async()=>100})).rejects.toMatchObject({code:'wrong-chain'});
    expect(simulation).not.toHaveBeenCalled();
    await expect(previewDecisionVote(profile,input,{...client,simulateContract:async()=>({status:'revert',revertReason:'upstream details'})})).rejects.toMatchObject({message:'simulation'});
  });
});
