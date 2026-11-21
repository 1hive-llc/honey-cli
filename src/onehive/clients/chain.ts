import { createPublicClient, createWalletClient, defineChain, http, type Abi, type Address, type Hex, type Transport } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { gnosis } from 'viem/chains';
import { rpcUrlFromEnv } from './rpc-url.js';
import type { ChainId, HexAddress, HexData, TxPreview } from '../schemas.js';

export { rpcUrlFromEnv } from './rpc-url.js';

export type ContractReadRequest = {
  address: HexAddress;
  abi: readonly unknown[];
  functionName: string;
  args?: unknown[];
  blockNumber?: bigint;
};

export type ContractSimulationRequest = Omit<ContractReadRequest, 'blockNumber'> & {
  account?: HexAddress;
  value?: bigint;
};

export type ChainClient = {
  chainId: ChainId;
  rpcUrl: string;
  getChainId(): Promise<number>;
  getBytecode(address: HexAddress): Promise<HexData | undefined>;
  readContract<T = unknown>(request: ContractReadRequest): Promise<T>;
  getBlockNumber?(): Promise<bigint>;
  simulateContract(request: ContractSimulationRequest): Promise<{ status: 'success' | 'revert'; gasEstimate?: bigint; revertReason?: string }>;
  call?(tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>): Promise<HexData>;
  estimateGas(tx: Pick<TxPreview, 'to' | 'data' | 'value' | 'from'>): Promise<bigint>;
  sendTransaction?(tx: Pick<TxPreview, 'to' | 'data' | 'value'> & Partial<Pick<TxPreview, 'simulation'>>, privateKey: HexData): Promise<HexData>;
};

const chiadoChain = defineChain({
  id: 10200,
  name: 'Chiado Testnet',
  nativeCurrency: { decimals: 18, name: 'xDAI', symbol: 'xDAI' },
  rpcUrls: { default: { http: ['https://rpc.chiadochain.net'] } }
});

const localForkChain = defineChain({
  id: 31337,
  name: 'Local Gnosis Fork',
  nativeCurrency: { decimals: 18, name: 'xDAI', symbol: 'xDAI' },
  rpcUrls: { default: { http: ['http://127.0.0.1:8545'] } }
});

function chainConfig(chainId: ChainId) {
  if (chainId === 100) return gnosis;
  if (chainId === 10200) return chiadoChain;
  return localForkChain;
}

function toViemValue(value?: string): bigint | undefined {
  if (value === undefined || value === '') return undefined;
  return BigInt(value);
}

function revertReason(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Contract simulation reverted or failed.';
}

function gasWithBuffer(gasEstimate?: string): bigint | undefined {
  if (!gasEstimate) return undefined;
  const gas = BigInt(gasEstimate);
  return gas > 0n ? gas * 150n / 100n + 10_000n : undefined;
}

export type CreateViemChainClientOptions = {
  chainId: ChainId;
  rpcUrl?: string;
  transport?: Transport;
};

export function createViemChainClient(options: CreateViemChainClientOptions): ChainClient {
  const rpcUrl = options.rpcUrl ?? rpcUrlFromEnv(options.chainId);
  const publicClient = createPublicClient({
    chain: chainConfig(options.chainId),
    transport: options.transport ?? http(rpcUrl)
  });

  return {
    chainId: options.chainId,
    rpcUrl,
    async getChainId() {
      return publicClient.getChainId();
    },
    async getBytecode(address) {
      return publicClient.getCode({ address: address as Address }) as Promise<Hex | undefined>;
    },
    async readContract<T = unknown>(request: ContractReadRequest) {
      return publicClient.readContract({
        address: request.address as Address,
        abi: request.abi as Abi,
        functionName: request.functionName,
        args: request.args ?? [],
        blockNumber: request.blockNumber
      }) as Promise<T>;
    },
    async getBlockNumber() {
      return publicClient.getBlockNumber();
    },
    async simulateContract(request: ContractSimulationRequest) {
      try {
        await publicClient.simulateContract({
          account: request.account as Address | undefined,
          address: request.address as Address,
          abi: request.abi as Abi,
          functionName: request.functionName,
          args: request.args ?? [],
          value: request.value
        });
        const gasEstimate = await publicClient.estimateContractGas({
          account: request.account as Address | undefined,
          address: request.address as Address,
          abi: request.abi as Abi,
          functionName: request.functionName,
          args: request.args ?? [],
          value: request.value
        });
        return { status: 'success' as const, gasEstimate };
      } catch (error) {
        return { status: 'revert' as const, revertReason: revertReason(error) };
      }
    },
    async call(tx) {
      const result = await publicClient.call({
        account: tx.from as Address | undefined,
        to: tx.to as Address,
        data: tx.data as Hex,
        value: toViemValue(tx.value)
      });
      return (result.data ?? '0x') as HexData;
    },
    async estimateGas(tx) {
      return publicClient.estimateGas({
        account: tx.from as Address | undefined,
        to: tx.to as Address,
        data: tx.data as Hex,
        value: toViemValue(tx.value)
      });
    },
    async sendTransaction(tx, privateKey) {
      const account = privateKeyToAccount(privateKey as Hex);
      const walletClient = createWalletClient({ account, chain: chainConfig(options.chainId), transport: options.transport ?? http(rpcUrl) });
      return walletClient.sendTransaction({
        account,
        to: tx.to as Address,
        data: tx.data as Hex,
        value: toViemValue(tx.value) ?? 0n,
        gas: gasWithBuffer(tx.simulation?.gasEstimate)
      }) as Promise<Hex>;
    }
  };
}

export function createChainClientFromEnv(chainId: ChainId): ChainClient {
  return createViemChainClient({ chainId });
}

export async function hasCode(client: Pick<ChainClient, 'getBytecode'>, address: HexAddress): Promise<boolean> {
  const bytecode = await client.getBytecode(address);
  return Boolean(bytecode && bytecode !== '0x');
}
