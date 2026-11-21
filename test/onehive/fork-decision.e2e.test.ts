import { describe, expect, it } from 'vitest';
import { createPublicClient, defineChain, formatUnits, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { buildSignAgreementPreview } from '../../src/onehive/tools/celeste.js';
import { buildDecisionCastVotePreview, buildDecisionExecutePreview, buildDecisionNewVotePreview, readDecisionVote } from '../../src/onehive/tools/decision.js';
import { submitTxPreview } from '../../src/onehive/tools/tx-submit.js';
import { createChainClientFromEnv, type ChainClient } from '../../src/onehive/clients/chain.js';
import { decodeDecisionEvents } from '../../src/onehive/clients/event-readback.js';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import type { HexAddress, TxPreview } from '../../src/onehive/schemas.js';
import { anvilSetBalance, evmIncreaseTime, evmMine, forkEnabled, forkRpcUrl, prepareAgreementActionCollateral, requireForkPrivateKey, transferTokenFromWhale } from './fork-helpers.js';

const run = forkEnabled ? describe : describe.skip;
const noopExecutionScript = '0x00000001' as const;

async function submitForkPreview(preview: TxPreview, client: ChainClient, privateKey: string) {
  const submitted = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'dev-private-key' }, { client, devPrivateKey: privateKey as `0x${string}` });
  expect(submitted.ok).toBe(true);
  return submitted.data!.txHash as `0x${string}`;
}

async function signAgreementIfNeeded(client: ChainClient, from: HexAddress, privateKey: string) {
  const signer = await client.readContract<readonly [bigint, boolean]>({ address: ONEHIVE.AGREEMENT, abi: agreementAbi, functionName: 'getSigner', args: [from] });
  if (!signer[1]) return;
  const settingId = await client.readContract<bigint>({ address: ONEHIVE.AGREEMENT, abi: agreementAbi, functionName: 'getCurrentSettingId' });
  const preview = await buildSignAgreementPreview({ chainId: 31337, from, settingId: settingId.toString() }, { client });
  expect(preview.ok).toBe(true);
  await submitForkPreview(preview.data!, client, privateKey);
}

run('local fork Decision/Disputable Voting E2E', () => {
  it('creates, votes, fast-forwards, and executes a no-op Decision vote', async () => {
    const privateKey = requireForkPrivateKey('FORK_DECISION_PRIVATE_KEY');
    const from = privateKeyToAccount(privateKey as `0x${string}`).address as HexAddress;
    const client = createChainClientFromEnv(31337);
    const publicClient = createPublicClient({
      chain: defineChain({ id: 31337, name: 'Local Gnosis Fork', nativeCurrency: { decimals: 18, name: 'xDAI', symbol: 'xDAI' }, rpcUrls: { default: { http: [forkRpcUrl] } } }),
      transport: http(forkRpcUrl)
    });

    await anvilSetBalance(from);
    await transferTokenFromWhale(TOKENS.HNY, from, '12000', ONEHIVE.AGENT_VAULT);
    await signAgreementIfNeeded(client, from, privateKey);
    await prepareAgreementActionCollateral(privateKey as `0x${string}`, '10');

    const newVote = await buildDecisionNewVotePreview({ chainId: 31337, from, context: 'ipfs://fork-decision-e2e', executionScript: noopExecutionScript }, { client });
    expect(newVote.ok).toBe(true);
    const newVoteHash = await submitForkPreview(newVote.data!, client, privateKey);
    const newVoteReceipt = await publicClient.waitForTransactionReceipt({ hash: newVoteHash });
    const start = decodeDecisionEvents(newVoteReceipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data }))).find((event) => event.eventName === 'StartVote');
    expect(start?.voteId).toBeTruthy();
    const voteId = start!.voteId!;

    const vote = await buildDecisionCastVotePreview({ chainId: 31337, from, voteId, supports: true }, { client });
    expect(vote.ok).toBe(true);
    const voteHash = await submitForkPreview(vote.data!, client, privateKey);
    const voteReceipt = await publicClient.waitForTransactionReceipt({ hash: voteHash });
    const cast = decodeDecisionEvents(voteReceipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data }))).find((event) => event.eventName === 'CastVote');
    expect(cast).toMatchObject({ voteId, voter: from, supports: true });

    const afterVote = await readDecisionVote({ chainId: 31337, voteId, voter: from }, { client });
    expect(afterVote.ok).toBe(true);
    expect(afterVote.data?.voter?.state).toBe('Yea');
    expect(Number(formatUnits(BigInt(afterVote.data!.yea), 18))).toBeGreaterThan(11_000);

    const fastForwardSeconds = Number(BigInt(afterVote.data!.setting.voteTime) + BigInt(afterVote.data!.setting.executionDelay) + 100n);
    await evmIncreaseTime(fastForwardSeconds);
    await evmMine();

    const executable = await readDecisionVote({ chainId: 31337, voteId }, { client });
    expect(executable.ok).toBe(true);
    expect(executable.data?.canExecute).toBe(true);

    const execute = await buildDecisionExecutePreview({ chainId: 31337, from, voteId, executionScript: noopExecutionScript }, { client });
    expect(execute.ok).toBe(true);
    const executeHash = await submitForkPreview(execute.data!, client, privateKey);
    const executeReceipt = await publicClient.waitForTransactionReceipt({ hash: executeHash });
    const executed = decodeDecisionEvents(executeReceipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data }))).find((event) => event.eventName === 'ExecuteVote');
    expect(executed).toMatchObject({ voteId });

    const finalState = await readDecisionVote({ chainId: 31337, voteId }, { client });
    expect(finalState.ok).toBe(true);
    expect(finalState.data?.status).toBe('Executed');
  }, 180_000);
});
