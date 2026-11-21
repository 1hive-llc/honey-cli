import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { ONEHIVE } from '../../src/onehive/addresses.js';
import { buildSignAgreementPreview } from '../../src/onehive/tools/celeste.js';
import { buildAddProposalPreview, buildProposalTokenPreview, readConvictionProposal } from '../../src/onehive/tools/governance.js';
import { submitTxPreview } from '../../src/onehive/tools/tx-submit.js';
import { resolveOneHiveContext } from '../../src/onehive/tools/context.js';
import { createChainClientFromEnv, type ChainClient } from '../../src/onehive/clients/chain.js';
import { findProposalAddedLog, findStakeEventLog } from '../../src/onehive/clients/event-readback.js';
import type { HexAddress, TxPreview } from '../../src/onehive/schemas.js';
import { anvilSetBalance, forkClient, forkEnabled, prepareAgreementActionCollateral, requireForkPrivateKey, transferHnyFromWhale } from './fork-helpers.js';

const run = forkEnabled ? describe : describe.skip;

async function submitForkPreview(preview: TxPreview, client: ChainClient, privateKey: string) {
  const submitted = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'dev-private-key' }, { client, devPrivateKey: privateKey as `0x${string}` });
  expect(submitted.ok).toBe(true);
  expect(submitted.data?.txHash).toMatch(/^0x/);
  return submitted.data!.txHash as `0x${string}`;
}

async function signCurrentAgreementIfNeeded(client: ChainClient, from: HexAddress, privateKey: string) {
  const signer = await client.readContract<readonly [bigint, boolean]>({ address: ONEHIVE.AGREEMENT, abi: agreementAbi, functionName: 'getSigner', args: [from] });
  if (!signer[1]) return;
  const settingId = await client.readContract<bigint>({ address: ONEHIVE.AGREEMENT, abi: agreementAbi, functionName: 'getCurrentSettingId' });
  const signPreview = await buildSignAgreementPreview({ chainId: 31337, from, settingId: settingId.toString() }, { client });
  expect(signPreview.ok).toBe(true);
  await submitForkPreview(signPreview.data!, client, privateKey);
}

async function createForkProposal(client: ChainClient, from: HexAddress, privateKey: string) {
  await signCurrentAgreementIfNeeded(client, from, privateKey);
  await prepareAgreementActionCollateral(privateKey as `0x${string}`, '10');
  const preview = await buildAddProposalPreview({
    chainId: 31337,
    from,
    title: `Fork E2E proposal ${Date.now()}`,
    link: 'ipfs://fork-e2e',
    requestedAmountHnyOrWxDai: '0.000000000000000001',
    stableRequestAmount: false,
    beneficiary: from
  }, { client });

  expect(preview.ok).toBe(true);
  const txHash = await submitForkPreview(preview.data!, client, privateKey);
  const receipt = await forkClient().waitForTransactionReceipt({ hash: txHash });
  const proposalEvent = findProposalAddedLog(receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })));
  return { txHash, proposalEvent };
}

run('local fork governance E2E', () => {
  it('resolves fork context and verifies deployed governance bytecode', async () => {
    const context = await resolveOneHiveContext({ chainId: 31337, verifyCode: true }, createChainClientFromEnv(31337));

    expect(context.chain.id).toBe(31337);
    expect(context.warnings.some((warning) => warning.includes('Local fork mode selected'))).toBe(true);
    expect(context.verification.some((entry) => entry.name === 'ONEHIVE_CONVICTION_VOTING' && entry.hasCode)).toBe(true);
  }, 60_000);

  it('submits a Conviction Voting addProposal transaction to the fork when fixture env is available', async () => {
    const privateKey = requireForkPrivateKey('FORK_PRIVATE_KEY');
    const from = privateKeyToAccount(privateKey).address as HexAddress;

    await anvilSetBalance(from);
    const client = createChainClientFromEnv(31337);
    const { proposalEvent } = await createForkProposal(client, from, privateKey);
    const proposal = await readConvictionProposal({ chainId: 31337, proposalId: proposalEvent.proposalId }, client);

    expect(proposal.proposalId).toBe(proposalEvent.proposalId);
    expect(proposal.beneficiary.toLowerCase()).toBe(from.toLowerCase());
    expect(proposal.requestedAmount).toBe('1');
  }, 120_000);

  it('stakes and withdraws HNY on a fork proposal using fork HNY fixture setup', async () => {
    const privateKey = requireForkPrivateKey('FORK_PRIVATE_KEY');
    const from = privateKeyToAccount(privateKey).address as HexAddress;

    await anvilSetBalance(from);
    const client = createChainClientFromEnv(31337);
    const { proposalEvent } = await createForkProposal(client, from, privateKey);
    await transferHnyFromWhale(from, '2');

    const stakePreview = await buildProposalTokenPreview({ chainId: 31337, from, proposalId: proposalEvent.proposalId, amountHny: '1' }, 'stake', { client });
    expect(stakePreview.ok).toBe(true);
    const stakeHash = await submitForkPreview(stakePreview.data!, client, privateKey);
    const stakeReceipt = await forkClient().waitForTransactionReceipt({ hash: stakeHash });
    const stakeEvent = findStakeEventLog(stakeReceipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })), 'StakeAdded');
    expect(stakeEvent.proposalId).toBe(proposalEvent.proposalId);
    expect(stakeEvent.amount).toBe('1000000000000000000');

    const withdrawPreview = await buildProposalTokenPreview({ chainId: 31337, from, proposalId: proposalEvent.proposalId, amountHny: '0.5' }, 'withdraw', { client });
    expect(withdrawPreview.ok).toBe(true);
    const withdrawHash = await submitForkPreview(withdrawPreview.data!, client, privateKey);
    const withdrawReceipt = await forkClient().waitForTransactionReceipt({ hash: withdrawHash });
    const withdrawEvent = findStakeEventLog(withdrawReceipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })), 'StakeWithdrawn');
    expect(withdrawEvent.proposalId).toBe(proposalEvent.proposalId);
    expect(withdrawEvent.amount).toBe('500000000000000000');
  }, 90_000);

  it('can read an existing mainnet proposal from fork state by RPC getter', async () => {
    const proposalId = process.env.FORK_EXISTING_PROPOSAL_ID ?? '212';
    const proposal = await readConvictionProposal({ chainId: 31337, proposalId }, createChainClientFromEnv(31337));

    expect(proposal.proposalId).toBe(proposalId);
    expect(proposal.beneficiary).toMatch(/^0x[a-fA-F0-9]{40}$/);
  }, 60_000);
});
