import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { decodeEventLog, keccak256, encodeAbiParameters, parseAbiItem, toEventSelector, zeroAddress, getAddress, hexToString, type Abi, type Address, type Hex, type AbiParameterToPrimitiveType } from 'viem';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import { agreementAbi, agreementResolutionAbi } from '../../src/onehive/abis/agreement.js';
import { disputableVotingAbi } from '../../src/onehive/abis/disputableVoting.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { coreAbi, classicAbi, adapterAbi } from '../../src/kleros-court/abis.js';
import { Snapshot } from '../../src/kleros-court/snapshot.js';
import { runCourtCli } from '../../src/kleros-court/cli.js';
import { Recording } from '../kleros-court/fixture.js';
import { query } from '../../src/web/queries.js';
import type { ChainClient, ContractReadRequest } from '../../src/onehive/clients/chain.js';
import { expect, it } from 'vitest';
import { evidenceEvent, observeJury, readPartyEvidence, type JuryDeps } from '../../src/web/jury.js';
import { profile } from '../../examples/governance/fixture.js';

const recorded = JSON.parse(readFileSync(new URL('./recorded-case.json', import.meta.url), 'utf8')) as {
  chainId: number; forkBlock: number; logs: {
    address: Address; data: Hex; topics: [Hex, ...Hex[]]; blockNumber: string; blockHash: Hex; transactionHash: Hex
  }[];
};
const adapter = '0x551704044afc6bf19db2ee6665e68c0890cb6f7c';
const core = '0x20272780f2fb5a6536703ee9899cf9ee35db9f25';
const kit = '0x22c29103111c66cc21371e746212ceb8636182d9';
const juror = '0x0000000000000000000000000000000000a11004';
const second = '0x0000000000000000000000000000000000a11c03';
const dispute = 73421987927038896577320958991808673182349354290645074277667629943137667489606n;
const reads = { ...profile, jurySimulation: true, evidenceFromBlock: "49330514" };
const createdEvent = parseAbiItem('event DisputeCreated(uint256 indexed disputeId, uint256 indexed coreId, bytes metadata)');
const drawEvent = parseAbiItem('event Draw(address indexed _address, uint256 indexed _disputeID, uint256 _roundID, uint256 _voteID)');
const voteEvent = parseAbiItem('event VoteCast(uint256 indexed _coreDisputeID, address indexed _juror, uint256[] _voteIDs, uint256 indexed _choice, string _justification)');
const periodEvent = parseAbiItem('event NewPeriod(uint256 indexed _disputeID, uint8 _period)');

type EventArgs<T extends { inputs: readonly { name?: string; type: string }[] }> = {
  [P in T['inputs'][number] as P['name'] extends string ? P['name'] : never]: AbiParameterToPrimitiveType<P>
};

function logs<T extends typeof createdEvent | typeof drawEvent | typeof voteEvent | typeof periodEvent | typeof evidenceEvent>(
  event: T, address: Address
) {
  return recorded.logs.filter(log => log.address.toLowerCase() === address.toLowerCase() && log.topics[0] === toEventSelector(event))
    .map(log => ({ ...log, args: decodeEventLog({ abi: [event], data: log.data, topics: log.topics }).args as EventArgs<T> }));
}
const link: Parameters<typeof observeJury>[2] = { core, arbitrator: adapter, coreDispute: '0', dispute: String(dispute), courtId: '1', state: 'Active Kleros case', period: 'vote' };

it('reconciles actual recorded evidence with the adapter and Core dispute', async () => {
  expect([recorded.chainId, recorded.forkBlock]).toEqual([31337, 49330462]);
  const [created] = logs(createdEvent, adapter);
  expect(created?.args).toMatchObject({ disputeId: dispute, coreId: 0n });
  expect(BigInt(keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [adapter, 0n])))).toBe(dispute);
  expect(BigInt('0x' + created!.args.metadata.slice(-64))).toBe(14n);
  const evidence: JuryDeps['evidence'] = async (address, id, from, to) => logs(evidenceEvent, address)
    .filter(log => log.args.disputeId === id && BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to)
    .map(log => ({ ...log, blockNumber: BigInt(log.blockNumber) }));
  const deps: JuryDeps = { evidence, simulateBallot: async () => { throw new Error('No simulation in receipt replay'); } };
  const result = await readPartyEvidence(reads, deps, adapter, dispute, 49330522n);
  expect(result.status).toBe('complete');
  expect(result.items.map(({ submitter, uri, transactionHash }) => [submitter.toLowerCase().slice(-6), uri, transactionHash])).toEqual([
    ['a11002', 'ipfs://fork-decision', created?.transactionHash],
    ['a11003', 'ipfs://challenge', created?.transactionHash],
  ]);
  expect(result.items.map(item => item.block)).toEqual([created?.blockNumber, created?.blockNumber]);
  await expect(readPartyEvidence(reads, deps, adapter, 0n, 49330522n)).resolves.toEqual({ status: 'complete', items: [] });
});

it('reconciles vote-period seat ownership and cast choices with actual Draw and VoteCast logs', async () => {
  const draws = logs(drawEvent, core);
  const votes = logs(voteEvent, kit);
  const opened = logs(periodEvent, core).find(log => log.args._period === 2);
  expect(opened?.blockNumber).toBe('49330522');
  expect(draws.map(({ args: a }) => [a._disputeID, a._roundID, a._voteID, a._address.toLowerCase()])).toEqual([
    [0n, 0n, 0n, juror], [0n, 0n, 1n, second], [0n, 0n, 2n, juror],
  ]);
  expect(votes.map(({ args: a, blockNumber }) => [a._coreDisputeID, a._juror.toLowerCase(), a._voteIDs, a._choice, a._justification, blockNumber])).toEqual([
    [0n, juror, [0n, 2n], 1n, 'Fork covenant assessment', '49330523'],
    [0n, second, [1n], 1n, 'Fork covenant assessment', '49330524'],
  ]);
  const owners = draws.map(log => log.args._address);
  // Project getter responses from events for this offline reconciliation; these are not captured eth_call bytes.
  function client(asOf: bigint): Parameters<typeof observeJury>[1] {
    return { readContract: async ({ functionName, args }: { functionName: string; args: bigint[] }) => {
      switch (functionName) {
        case 'getNumberOfRounds': return 1n;
        case 'agreementDisputeByCore': return dispute;
        case 'arbitrationPaused': return false;
        case 'getRoundInfo': return { drawnJurors: owners, nbVotes: 3n, disputeKitID: 1n, courtParamsIndex: 0n };
        case 'disputeKits': expect(args).toEqual([1n]); return kit;
        case 'getAdditionalCourtParams': return { hiddenVotes: false };
        case 'core': return core;
        case 'coreDisputeIDToActive': return [true, true];
        case 'getVoteInfo': {
          const id = args[2]!;
          const cast = votes.find(log => BigInt(log.blockNumber) <= asOf && log.args._voteIDs.includes(id));
          if (cast) expect(cast.args._juror).toBe(owners[Number(id)]);
          return [owners[Number(id)], '0x', cast?.args._choice ?? 0n, Boolean(cast)];
        }
        default: throw new Error('Unexpected read: ' + functionName);
      }
    } } as unknown as Parameters<typeof observeJury>[1];
  }
  const before = await observeJury(reads, client(49330522n), link, juror);
  expect(before.jury).toMatchObject({ roundId: '0', canPreview: true, seats: [
    { voteId: '0', voted: false, choice: null }, { voteId: '2', voted: false, choice: null },
  ] });
  const other = await observeJury(reads, client(49330523n), link, second);
  expect(other.jury).toMatchObject({ canPreview: true, seats: [{ voteId: '1', voted: false, choice: null }] });
  const after = await observeJury(reads, client(49330524n), link, juror);
  expect(after.jury).toMatchObject({ canPreview: false, seats: [
    { voteId: '0', voted: true, choice: '1' }, { voteId: '2', voted: true, choice: '1' },
  ] });
});

// Replay one recorded local Decision. Getter bytes are projections, NOT captured calls.
// Unobserved ABI fields are placeholders; no assertion about economics or timing.
const { AGREEMENT: agreement, DISPUTABLE_VOTING: app } = ONEHIVE;
const honey = TOKENS.HNY, zeroHash = ('0x' + '00'.repeat(32)) as Hex;
const party = logs(evidenceEvent, adapter);
function projection(asOf: bigint, syntheticRefusal = false) {
  const [submitter, challenger] = party.map(x => x.args);
  const seats = logs(drawEvent, core).map(l => l.args._address);
  const cast = logs(voteEvent, kit).filter(l => BigInt(l.blockNumber) <= asOf);
  const b = new Recording()
    .set(core, coreAbi, 'pinakion', [], honey).set(honey, erc20Abi, 'decimals', [], 18)
    .set(agreement, agreementAbi, 'getCurrentSettingId', [], 2n)
    .set(agreement, agreementResolutionAbi, 'getSetting', [2n], [adapter, zeroAddress, '', '0x'])
    .set(app, disputableVotingAbi, 'getVote', [21n], [0n,0n,0n,0n,0n,0,2n,235n,0n,0n,0n,0,zeroHash])
    .set(agreement, agreementAbi, 'getAction', [235n], [app,21n,0n,2n,submitter!.submitter,false,submitter!.evidence,14n,true])
    .set(agreement, agreementAbi, 'getChallenge', [14n], [235n,challenger!.submitter,0n,challenger!.evidence,0n,2,false,false,dispute,0n])
    .set(adapter, adapterAbi, 'core', [], core).set(adapter, adapterAbi, 'honey', [], honey)
    .set(adapter, adapterAbi, 'agreement', [], agreement)
    .set(adapter, adapterAbi, 'disputes', [dispute], [0n,0n,true,false])
    .set(adapter, adapterAbi, 'agreementDisputeByCore', [0n], dispute)
    .set(core, coreAbi, 'disputes', [0n], [1n,adapter,2,false,0n])
    .set(core, coreAbi, 'arbitrationPaused', [], false)
    .set(core, coreAbi, 'getNumberOfRounds', [0n], 1n)
    .set(core, coreAbi, 'disputeKits', [1n], kit)
    .set(core, coreAbi, 'getRoundInfo', [0n,0n], { disputeKitID:1n, pnkAtStakePerJuror:0n,
      totalFeesForJurors:0n, nbVotes:BigInt(seats.length), repartitions:0n, pnkPenalties:0n,
      drawnJurors:seats, drawnJurorFromCourtIDs:seats.map(() => 1n), sumFeeRewardPaid:0n, sumPnkRewardPaid:0n,
      feeToken:honey, drawIterations:BigInt(seats.length), courtParamsIndex:0n, __gap:Array(10).fill(0n) })
    .set(core, coreAbi, 'getAdditionalCourtParams', [1n,0n], { hiddenVotes:false, jurorsForCourtJump:0n, timesPerPeriod:[0n,0n,0n,0n] })
    .set(kit, classicAbi, 'core', [], core).set(kit, classicAbi, 'coreDisputeIDToActive', [0n], [true,true]);
  seats.forEach((owner, i) => {
    const vote = cast.find(v => v.args._voteIDs.includes(BigInt(i)));
    b.set(kit, classicAbi, 'getVoteInfo', [0n,0n,BigInt(i)], [owner,zeroHash,syntheticRefusal ? 0n : vote?.args._choice ?? 0n,Boolean(vote)]);
  });
  const header = recorded.logs.find(l => l.blockNumber === String(asOf))!;
  return { ...b.json(), blockNumber:String(asOf), blockHash:header.blockHash, timestamp:'0' };
}

it.each([
  ['before voting',49330522n,juror,false,[['0',false,null],['2',false,null]]],
  ['first ballot',49330523n,juror,false,[['0',true,'1'],['2',true,'1']]],
  ['second ballot',49330524n,second,false,[['1',true,'1']]],
  ['synthetic refusal (not a recorded vote)',49330523n,juror,true,[['0',true,'0'],['2',true,'0']]],
] as const)('replays %s through CLI my-votes and the browser jury query', async (_, height, account, refusal, expected) => {
  const saved = projection(height, refusal), snapshot = new Snapshot(saved);
  const dir = mkdtempSync(join(tmpdir(), 'honey-parity-')), path = join(dir, 'projected.json');
  try {
    writeFileSync(path, JSON.stringify(saved));
    let out = '';
    const code = await runCourtCli(['kleros','juror','my-votes','--snapshot',path,'--json'], {
      stdin:JSON.stringify({ chainId:31337, core, honey, from:account, adapter, agreement, classic:kit, challengeId:'14', roundId:'0' }),
      stdout:{write(s: string) { out += s; return true; }}
    });
    expect(code,out).toBe(0);
    const cli = JSON.parse(out).data;
    const never = async (): Promise<never> => { throw Error('Not supported in a receipt replay'); };
    const client: ChainClient = { chainId:31337, rpcUrl:'offline:', getChainId:async()=>31337,
      getBlockNumber:async()=>height, getBytecode:never, simulateContract:never, estimateGas:never,
      async readContract<T>(req: ContractReadRequest) {
        expect(req.blockNumber).toBe(height);
        return snapshot.read(req.abi as Abi,req.address,req.functionName,req.args ?? []) as T;
      }
    };
    const p = {...reads, adapter} as const;
    const web = await query(p,{op:'jury',input:{kind:'votes',id:'21',account}}, {client,index:never,jury:{
      simulateBallot:never, evidence:async (address,id,from,to) =>
        logs(evidenceEvent,address).filter(l => l.args.disputeId===id && BigInt(l.blockNumber)>=from && BigInt(l.blockNumber)<=to)
          .map(l => ({...l,blockNumber:BigInt(l.blockNumber)}))
    }});
    if (!('jury' in web) || !web.jury || !('evidence' in web)) throw Error('missing web jury');
    const cases = await query({...p,source:'known-ids',known:{proposals:[],votes:['21']}},{op:'list',area:'cases',page:1},{client,index:never});
    expect(cases).toMatchObject({block:web.block,rows:[{id:cli.ids.appActionId,kind:'votes',court:{
      actionId:cli.ids.actionId,challenge:cli.ids.challengeId,dispute:cli.ids.agreementDisputeId,
      coreDispute:cli.ids.coreDisputeId,courtId:cli.ids.courtId,period:cli.period
    }}]});
    expect(cli.block.blockNumber).toBe(web.block);
    expect(cli.ids).toMatchObject({app:getAddress(app), appActionId:'21',actionId:'235',challengeId:'14',
      agreementDisputeId:String(dispute),coreDisputeId:'0',courtId:'1',roundId:web.jury.roundId});
    expect(cli.seats).toEqual(web.jury.seats);
    expect(cli.seats).toEqual(expected.map(([voteId,voted,choice])=>({voteId,voted,choice})));
    // CLI provides party contexts, not transaction hashes. Join each to actual adapter receipts.
    const ctx = cli.caseContext;
    expect(web.evidence.status).toBe('complete');
    expect(web.evidence.items).toEqual([[ctx.submitter,ctx.actionContext],[ctx.challenger,ctx.challengeContext]].map(([submitter,bytes])=>({
      submitter,uri:hexToString(bytes),block:'49330514',transactionHash:'0x17bc86a8a907bb65c393d33d6b75b88085fb68f5a848e6017fb6743e55a09f9d'
    })));
    // Optional smoke-test handoff. Export only checkpoints which passed every parity check.
    if (process.env.HONEY_REPLAY_EXPORT_DIR && !refusal) {
      const ballot = logs(voteEvent,kit).find(l => l.blockNumber===String(height));
      writeFileSync(join(process.env.HONEY_REPLAY_EXPORT_DIR, String(height)+'.json'),JSON.stringify({
        account, ids:cli.ids, block:web.block, jury:web.jury, evidence:web.evidence,
        ballotHash:ballot?.transactionHash ?? null
      }));
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
