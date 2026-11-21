import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { createChainClientFromEnv, type ChainClient } from '../../src/onehive/clients/chain.js';
import { buildHoneyApprovalPreview, buildHoneyQuote, buildHoneySwapPreview } from '../../src/onehive/tools/honey.js';
import { submitTxPreview } from '../../src/onehive/tools/tx-submit.js';
import { honeyswapFactoryAbi } from '../../src/onehive/abis/honeyswap.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { HONEYSWAP, TOKENS } from '../../src/onehive/addresses.js';
import type { HexAddress, TxPreview } from '../../src/onehive/schemas.js';
import { anvilSetBalance, forkEnabled, requireForkPrivateKey, wrapXdai } from './fork-helpers.js';

const run = forkEnabled ? describe : describe.skip;

async function submitForkPreview(preview: TxPreview, client: ChainClient, privateKey: string) {
  const submitted = await submitTxPreview({ tx: preview, confirmationPhrase: preview.policy.confirmationPhrase, signerMode: 'dev-private-key' }, { client, devPrivateKey: privateKey as `0x${string}` });
  expect(submitted.ok).toBe(true);
  return submitted.data!.txHash as `0x${string}`;
}

run('local fork Honey swap E2E', () => {
  it('quotes, approves, and swaps WXDAI for HNY on a local Gnosis fork', async () => {
    const privateKey = requireForkPrivateKey('FORK_HONEY_PRIVATE_KEY');
    const from = privateKeyToAccount(privateKey as `0x${string}`).address as HexAddress;
    await anvilSetBalance(from);

    const client = createChainClientFromEnv(31337);
    const pair = await client.readContract<HexAddress>({ address: HONEYSWAP.FACTORY, abi: honeyswapFactoryAbi, functionName: 'getPair', args: [TOKENS.WXDAI, TOKENS.HNY] });
    expect(pair.toLowerCase()).not.toBe('0x0000000000000000000000000000000000000000');
    await wrapXdai(privateKey as `0x${string}`, '0.05');

    const hnyBefore = await client.readContract<bigint>({ address: TOKENS.HNY, abi: erc20Abi, functionName: 'balanceOf', args: [from] });
    const wxdaiBefore = await client.readContract<bigint>({ address: TOKENS.WXDAI, abi: erc20Abi, functionName: 'balanceOf', args: [from] });

    const approval = await buildHoneyApprovalPreview({ chainId: 31337, token: TOKENS.WXDAI, amount: '0.05', from }, { client });
    expect(approval.ok).toBe(true);
    await submitForkPreview(approval.data!, client, privateKey);

    const quote = await buildHoneyQuote({ chainId: 31337, side: 'buy', exact: 'input', amount: '0.01', slippageBps: 100 }, { client });
    expect(quote.ok).toBe(true);
    expect(quote.data?.quoteId).toBeTruthy();
    expect(quote.data?.priceImpactBps ?? 0).toBeLessThanOrEqual(500);

    const swap = await buildHoneySwapPreview({
      chainId: 31337,
      side: 'buy',
      exact: 'input',
      amount: '0.01',
      slippageBps: 100,
      recipient: from,
      from,
      quoteId: quote.data!.quoteId
    }, { client });
    expect(swap.ok).toBe(true);
    await submitForkPreview(swap.data!, client, privateKey);

    const hnyAfter = await client.readContract<bigint>({ address: TOKENS.HNY, abi: erc20Abi, functionName: 'balanceOf', args: [from] });
    const wxdaiAfter = await client.readContract<bigint>({ address: TOKENS.WXDAI, abi: erc20Abi, functionName: 'balanceOf', args: [from] });
    expect(hnyAfter).toBeGreaterThan(hnyBefore);
    expect(wxdaiAfter).toBeLessThan(wxdaiBefore);
  }, 120_000);
});
