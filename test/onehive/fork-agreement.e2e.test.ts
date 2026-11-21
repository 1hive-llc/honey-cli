import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { buildAddProposalPreview } from '../../src/onehive/tools/governance.js';
import { buildChallengeActionPreview, readAgreementState } from '../../src/onehive/tools/celeste.js';
import { submitTxPreview } from '../../src/onehive/tools/tx-submit.js';
import { createChainClientFromEnv, type ChainClient } from '../../src/onehive/clients/chain.js';
import { decodeAgreementEvents, findProposalAddedLog } from '../../src/onehive/clients/event-readback.js';
import type { HexAddress, TxPreview } from '../../src/onehive/schemas.js';
import { anvilSetBalance, approveHnyForAgreement, forkClient, forkEnabled, prepareAgreementActionCollateral, requireForkPrivateKey } from './fork-helpers.js';
import { buildSignAgreementPreview } from '../../src/onehive/tools/celeste.js';
import { agreementAbi } from '../../src/onehive/abis/agreement.js';
import { ONEHIVE } from '../../src/onehive/addresses.js';

const run = forkEnabled ? describe : describe.skip;

async function submitForkPreview(preview: TxPreview, client: ChainClient, privateKey: string) {
  const submitted = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'dev-private-key' }, { client, devPrivateKey: privateKey as `0x${string}` });
  expect(submitted.ok).toBe(true);
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

async function createChallengeableProposal(client: ChainClient, from: HexAddress, privateKey: string) {
  await signCurrentAgreementIfNeeded(client, from, privateKey);
  await prepareAgreementActionCollateral(privateKey as `0x${string}`, '10');
  const add = await buildAddProposalPreview({
    chainId: 31337,
    from,
    title: `Fork challenge target ${Date.now()}`,
    link: 'ipfs://fork-challenge-target',
    requestedAmountHnyOrWxDai: '0.000000000000000001',
    stableRequestAmount: false,
    beneficiary: from
  }, { client });
  expect(add.ok).toBe(true);
  const hash = await submitForkPreview(add.data!, client, privateKey);
  const receipt = await forkClient().waitForTransactionReceipt({ hash });
  return findProposalAddedLog(receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })));
}

run('local fork Agreement/Celeste wrapper E2E', () => {
  it('challenges a fork-created Conviction Voting action and reads challenge state', async () => {
    const privateKey = requireForkPrivateKey('FORK_AGREEMENT_PRIVATE_KEY');
    const from = privateKeyToAccount(privateKey as `0x${string}`).address as HexAddress;
    await anvilSetBalance(from);

    const client = createChainClientFromEnv(31337);
    const proposal = await createChallengeableProposal(client, from, privateKey);
    await approveHnyForAgreement(privateKey as `0x${string}`, '10');

    const challenge = await buildChallengeActionPreview({
      chainId: 31337,
      from,
      actionId: proposal.actionId,
      settlementOfferHny: '0',
      finishedEvidence: true,
      context: 'ipfs://fork-challenge-evidence'
    }, { client });
    expect(challenge.ok).toBe(true);

    const hash = await submitForkPreview(challenge.data!, client, privateKey);
    const receipt = await forkClient().waitForTransactionReceipt({ hash });
    const events = decodeAgreementEvents(receipt.logs.map((log) => ({ address: log.address, topics: log.topics, data: log.data })));
    const challenged = events.find((event) => event.eventName === 'ActionChallenged');
    expect(challenged).toMatchObject({ actionId: proposal.actionId });

    const state = await readAgreementState({ chainId: 31337, actionId: proposal.actionId }, { client });
    expect(state.ok).toBe(true);
    expect(state.data?.action?.lastChallengeActive).toBe(true);
    expect(state.data?.challenge?.state).toBe('Waiting');
  }, 180_000);
});
