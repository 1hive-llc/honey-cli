import { keccak256 } from 'viem';
import { erc20Abi } from '../abis/erc20.js';
import { CELESTE, CHAINS, HONEYSWAP, ONEHIVE, TOKENS, addressFromEnvOrReference } from '../addresses.js';
import { createChainClientFromEnv, type ChainClient } from '../clients/chain.js';
import type { ToolDefinition } from '../tool-types.js';
import { addressPattern, fail, ok, type ChainId, type HexAddress } from '../schemas.js';

export type ContextResolveInput = {
  chainId?: ChainId;
  verifyCode?: boolean;
  includeBalancesFor?: HexAddress;
};

export type ContextResolveOutput = {
  chain: {
    id: ChainId;
    name: string;
    nativeCurrency: string;
    rpcUrl?: string;
  };
  contracts: Record<string, HexAddress>;
  tokens: Record<string, { address: HexAddress; decimals?: number; symbol?: string; balance?: string }>;
  featureFlags: {
    disputableVotingWritesEnabled: boolean;
    mainnetSubmissionEnabled: boolean;
  };
  verification: Array<{ name: string; address: HexAddress; hasCode?: boolean; bytecodeHash?: string }>;
};

type TokenMetadata = { symbol?: string; decimals?: number; balance?: string };

function contractAddresses(): Record<string, HexAddress> {
  return {
    ONEHIVE_DAO_KERNEL: addressFromEnvOrReference('ONEHIVE_DAO_KERNEL', 'onehive', 'daoKernel', ONEHIVE.DAO_KERNEL),
    ONEHIVE_ACL: addressFromEnvOrReference('ONEHIVE_ACL', 'onehive', 'acl', ONEHIVE.ACL),
    ONEHIVE_CONVICTION_VOTING: addressFromEnvOrReference('ONEHIVE_CONVICTION_VOTING', 'onehive', 'convictionVoting', ONEHIVE.CONVICTION_VOTING),
    ONEHIVE_DISPUTABLE_VOTING: addressFromEnvOrReference('ONEHIVE_DISPUTABLE_VOTING', 'onehive', 'disputableVoting', ONEHIVE.DISPUTABLE_VOTING),
    ONEHIVE_AGREEMENT: addressFromEnvOrReference('ONEHIVE_AGREEMENT', 'onehive', 'agreement', ONEHIVE.AGREEMENT),
    ONEHIVE_HOOKED_TOKEN_MANAGER: addressFromEnvOrReference('ONEHIVE_HOOKED_TOKEN_MANAGER', 'onehive', 'hookedTokenManager', ONEHIVE.HOOKED_TOKEN_MANAGER),
    ONEHIVE_AGENT_VAULT: addressFromEnvOrReference('ONEHIVE_AGENT_VAULT', 'onehive', 'agentVault', ONEHIVE.AGENT_VAULT),
    ONEHIVE_HONEY_STAKING: addressFromEnvOrReference('ONEHIVE_HONEY_STAKING', 'onehive', 'honeyStaking', ONEHIVE.HONEY_STAKING),
    ONEHIVE_PRICE_ORACLE: addressFromEnvOrReference('ONEHIVE_PRICE_ORACLE', 'onehive', 'priceOracle', ONEHIVE.PRICE_ORACLE),
    ONEHIVE_FEES_UPDATER: addressFromEnvOrReference('ONEHIVE_FEES_UPDATER', 'onehive', 'feesUpdater', ONEHIVE.FEES_UPDATER),
    ONEHIVE_COLLATERAL_UPDATER: addressFromEnvOrReference('ONEHIVE_COLLATERAL_UPDATER', 'onehive', 'collateralUpdater', ONEHIVE.COLLATERAL_UPDATER),
    HONEYSWAP_FACTORY: addressFromEnvOrReference('HONEYSWAP_FACTORY', 'honeyswap', 'factory', HONEYSWAP.FACTORY),
    HONEYSWAP_ROUTER: addressFromEnvOrReference('HONEYSWAP_ROUTER', 'honeyswap', 'router02', HONEYSWAP.ROUTER),
    CELESTE_XDAI_COURT: addressFromEnvOrReference('CELESTE_XDAI_COURT', 'celeste', 'court', CELESTE.COURT),
    CELESTE_XDAI_DISPUTE: addressFromEnvOrReference('CELESTE_XDAI_DISPUTE', 'celeste', 'dispute', CELESTE.DISPUTE),
    CELESTE_XDAI_REGISTRY: addressFromEnvOrReference('CELESTE_XDAI_REGISTRY', 'celeste', 'registry', CELESTE.REGISTRY),
    CELESTE_XDAI_TREASURY: addressFromEnvOrReference('CELESTE_XDAI_TREASURY', 'celeste', 'treasury', CELESTE.TREASURY),
    CELESTE_XDAI_SUBSCRIPTIONS: addressFromEnvOrReference('CELESTE_XDAI_SUBSCRIPTIONS', 'celeste', 'subscriptions', CELESTE.SUBSCRIPTIONS)
  };
}

function tokenAddresses(): Record<'HNY' | 'WXDAI', HexAddress> {
  return {
    HNY: addressFromEnvOrReference('ONEHIVE_HNY', 'tokens', 'HNY', TOKENS.HNY),
    WXDAI: addressFromEnvOrReference('WXDAI', 'tokens', 'WXDAI', TOKENS.WXDAI)
  };
}

async function readTokenMetadata(client: ChainClient, tokenName: string, token: HexAddress, warnings: string[], balanceOwner?: HexAddress): Promise<TokenMetadata> {
  const [symbolResult, decimalsResult, balanceResult] = await Promise.allSettled([
    client.readContract<string>({ address: token, abi: erc20Abi, functionName: 'symbol' }),
    client.readContract<number>({ address: token, abi: erc20Abi, functionName: 'decimals' }),
    balanceOwner
      ? client.readContract<bigint>({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [balanceOwner] })
      : Promise.resolve(undefined)
  ]);

  const metadata: TokenMetadata = {};
  if (symbolResult.status === 'fulfilled') metadata.symbol = symbolResult.value;
  else warnings.push(`Token metadata read failed for ${tokenName}.symbol: ${symbolResult.reason instanceof Error ? symbolResult.reason.message : 'unknown error'}`);

  if (decimalsResult.status === 'fulfilled') metadata.decimals = Number(decimalsResult.value);
  else warnings.push(`Token metadata read failed for ${tokenName}.decimals: ${decimalsResult.reason instanceof Error ? decimalsResult.reason.message : 'unknown error'}`);

  if (balanceResult.status === 'fulfilled' && balanceResult.value !== undefined) metadata.balance = balanceResult.value.toString();
  else if (balanceResult.status === 'rejected') warnings.push(`Token balance read failed for ${tokenName}: ${balanceResult.reason instanceof Error ? balanceResult.reason.message : 'unknown error'}`);
  return metadata;
}

async function verificationRows(
  client: ChainClient,
  entries: Array<[string, HexAddress]>,
  warnings: string[]
): Promise<ContextResolveOutput['verification']> {
  return Promise.all(entries.map(async ([name, address]) => {
    try {
      const bytecode = await client.getBytecode(address);
      const hasCode = Boolean(bytecode && bytecode !== '0x');
      if (!hasCode) warnings.push(`Bytecode verification found no code for ${name} at ${address}.`);
      return {
        name,
        address,
        hasCode,
        ...(hasCode && bytecode ? { bytecodeHash: keccak256(bytecode) } : {})
      };
    } catch (error) {
      warnings.push(`Bytecode verification failed for ${name}: ${error instanceof Error ? error.message : 'unknown error'}`);
      return { name, address, hasCode: false };
    }
  }));
}

export class WrongChainError extends Error {
  constructor(readonly requestedChainId: ChainId, readonly actualChainId: number) {
    super(`RPC endpoint is connected to chain ${actualChainId}, but onehive_context_resolve requested chain ${requestedChainId}.`);
  }
}

export async function resolveOneHiveContext(input: ContextResolveInput, client = createChainClientFromEnv(input.chainId ?? 100)): Promise<ContextResolveOutput & { warnings: string[] }> {
  const chainId = input.chainId ?? 100;
  const chain = chainId === 100 ? CHAINS.gnosis : chainId === 10200 ? CHAINS.chiado : CHAINS.localFork;
  const contracts = contractAddresses();
  const tokenMap = tokenAddresses();
  const warnings = [
    'Address references may be stale; verify runtime bytecode before relying on mainnet write targets.',
    'Decision/Disputable Voting writes are enabled only as unsigned simulated previews with confirmation-gated unsigned Safe handoff.',
    'Mainnet private-key submission remains disabled; use a Safe handoff for unsigned review.'
  ];

  if (chainId !== client.chainId) {
    warnings.push(`Requested chain ${chainId} but injected client was configured for chain ${client.chainId}.`);
  }
  const activeChainId = await client.getChainId();
  if (activeChainId !== chainId) throw new WrongChainError(chainId, activeChainId);

  if (chainId === 10200) {
    warnings.push('Chiado/test mode selected; ensure environment overrides point to Chiado deployments before building transactions.');
  }
  if (chainId === 31337) {
    warnings.push('Local fork mode selected; using Gnosis mainnet addresses against the configured fork RPC. Subgraphs will not reflect fork-local transactions.');
  }

  const tokens: ContextResolveOutput['tokens'] = {
    HNY: { address: tokenMap.HNY },
    WXDAI: { address: tokenMap.WXDAI }
  };

  for (const [symbol, address] of Object.entries(tokenMap) as Array<[keyof typeof tokenMap, HexAddress]>) {
    try {
      tokens[symbol] = {
        address,
        ...(await readTokenMetadata(client, symbol, address, warnings, input.includeBalancesFor))
      };
    } catch (error) {
      warnings.push(`Token metadata read failed for ${symbol}: ${error instanceof Error ? error.message : 'unknown error'}`);
    }
  }

  const verificationEntries = [
    ...Object.entries(contracts),
    ...Object.entries(tokenMap)
  ] as Array<[string, HexAddress]>;

  const verification = input.verifyCode
    ? await verificationRows(client, verificationEntries, warnings)
    : verificationEntries.map(([name, address]) => ({ name, address }));

  if (!input.verifyCode) warnings.push('Bytecode verification was not requested; verification rows include addresses only.');

  return {
    chain: { id: chain.id as ChainId, name: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrl: client.rpcUrl },
    contracts,
    tokens,
    featureFlags: {
      disputableVotingWritesEnabled: true,
      mainnetSubmissionEnabled: false
    },
    verification,
    warnings
  };
}

export const contextResolveTool: ToolDefinition<ContextResolveInput, ContextResolveOutput> = {
  name: 'onehive_context_resolve',
  description: 'Resolve 1Hive chain, token, contract, and feature-flag context. Optionally verify bytecode.',
  inputSchema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      chainId: { enum: [100, 10200, 31337] },
      verifyCode: { type: 'boolean' },
      includeBalancesFor: { type: 'string', pattern: addressPattern }
    }
  },
  async handler(input) {
    try {
      const { warnings, ...data } = await resolveOneHiveContext(input);
      return ok(data, warnings);
    } catch (error) {
      if (error instanceof WrongChainError) {
        return fail('wrong_chain', error.message, {
          requestedChainId: error.requestedChainId,
          actualChainId: error.actualChainId
        }, false);
      }
      return fail('context_resolve_failed', error instanceof Error ? error.message : 'Failed to resolve 1Hive context.', undefined, true);
    }
  }
};
