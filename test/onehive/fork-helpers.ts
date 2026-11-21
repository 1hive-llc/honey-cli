import { createPublicClient, createWalletClient, encodeFunctionData, http, parseUnits, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { defineChain } from 'viem';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { ONEHIVE, TOKENS } from '../../src/onehive/addresses.js';
import type { HexAddress } from '../../src/onehive/schemas.js';

export const forkEnabled = process.env.RUN_FORK_E2E === '1';
export const forkRpcUrl = process.env.FORK_RPC_URL ?? 'http://127.0.0.1:8545';
export const forkChain = defineChain({
  id: 31337,
  name: 'Local Gnosis Fork',
  nativeCurrency: { decimals: 18, name: 'xDAI', symbol: 'xDAI' },
  rpcUrls: { default: { http: [forkRpcUrl] } }
});

export function requireForkPrivateKey(envName: string): Hex {
  const value = process.env[envName];
  if (!value || !/^0x[a-fA-F0-9]{64}$/.test(value)) {
    throw new Error(`${envName} is required and must be a 32-byte hex private key when RUN_FORK_E2E=1.`);
  }
  return value as Hex;
}

export function forkClient() {
  return createPublicClient({ chain: forkChain, transport: http(forkRpcUrl) });
}

export async function anvilSetBalance(address: HexAddress, weiHex = '0x56BC75E2D63100000') {
  await forkClient().request({ method: 'anvil_setBalance', params: [address, weiHex] } as any);
}

export async function anvilImpersonateAccount(address: HexAddress) {
  await forkClient().request({ method: 'anvil_impersonateAccount', params: [address] } as any);
}

export async function anvilStopImpersonatingAccount(address: HexAddress) {
  await forkClient().request({ method: 'anvil_stopImpersonatingAccount', params: [address] } as any);
}

export async function evmIncreaseTime(seconds: number) {
  await forkClient().request({ method: 'evm_increaseTime', params: [seconds] } as any);
}

export async function evmMine() {
  await forkClient().request({ method: 'evm_mine', params: [] } as any);
}

const stakingAbi = [
  { type: 'function', name: 'stake', stateMutability: 'nonpayable', inputs: [{ name: '_amount', type: 'uint256' }, { name: '_data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'allowManager', stateMutability: 'nonpayable', inputs: [{ name: '_lockManager', type: 'address' }, { name: '_allowance', type: 'uint256' }, { name: '_data', type: 'bytes' }], outputs: [] },
  { type: 'function', name: 'increaseLockAllowance', stateMutability: 'nonpayable', inputs: [{ name: '_lockManager', type: 'address' }, { name: '_allowance', type: 'uint256' }], outputs: [] }
] as const;

export async function transferTokenFromWhale(token: HexAddress, to: HexAddress, amount = '1', whale?: HexAddress) {
  const source = whale ?? '0x4505b262DC053998C10685DC5F9098af8AE5C8ad' as HexAddress;
  await anvilImpersonateAccount(source);
  await anvilSetBalance(source);
  try {
    const hash = await forkClient().request({
      method: 'eth_sendTransaction',
      params: [{
        from: source,
        to: token,
        value: '0x0',
        data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, parseUnits(amount, 18)] })
      }]
    } as any) as Hex;
    await forkClient().waitForTransactionReceipt({ hash });
    return hash;
  } finally {
    await anvilStopImpersonatingAccount(source);
  }
}

export async function transferHnyFromWhale(to: HexAddress, amount = '1') {
  const whale = process.env.FORK_HNY_WHALE as HexAddress | undefined;
  return transferTokenFromWhale(TOKENS.HNY, to, amount, whale);
}

export async function wrapXdai(privateKey: Hex, amount = '1') {
  const account = privateKeyToAccount(privateKey);
  await anvilSetBalance(account.address as HexAddress);
  const wallet = createWalletClient({ account, chain: forkChain, transport: http(forkRpcUrl) });
  const hash = await wallet.sendTransaction({
    account,
    to: TOKENS.WXDAI,
    data: '0xd0e30db0',
    value: parseUnits(amount, 18)
  });
  await forkClient().waitForTransactionReceipt({ hash });
}

export async function approveHnyForAgreement(privateKey: Hex, amount = '10') {
  const account = privateKeyToAccount(privateKey);
  await transferHnyFromWhale(account.address as HexAddress, amount);
  const wallet = createWalletClient({ account, chain: forkChain, transport: http(forkRpcUrl) });
  const hash = await wallet.sendTransaction({
    account,
    to: TOKENS.HNY,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ONEHIVE.AGREEMENT, parseUnits(amount, 18)] }),
    value: 0n
  });
  await forkClient().waitForTransactionReceipt({ hash });
}

export async function prepareAgreementActionCollateral(privateKey: Hex, amount = '1') {
  const account = privateKeyToAccount(privateKey);
  await transferHnyFromWhale(account.address as HexAddress, amount);
  const wallet = createWalletClient({ account, chain: forkChain, transport: http(forkRpcUrl) });
  const stakeAmount = parseUnits(amount, 18);
  const approveHash = await wallet.sendTransaction({
    account,
    to: TOKENS.HNY,
    data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [ONEHIVE.HONEY_STAKING, stakeAmount] }),
    value: 0n
  });
  await forkClient().waitForTransactionReceipt({ hash: approveHash });
  const stakeHash = await wallet.sendTransaction({
    account,
    to: ONEHIVE.HONEY_STAKING,
    data: encodeFunctionData({ abi: stakingAbi, functionName: 'stake', args: [stakeAmount, '0x'] }),
    value: 0n
  });
  await forkClient().waitForTransactionReceipt({ hash: stakeHash });
  try {
    const allowHash = await wallet.sendTransaction({
      account,
      to: ONEHIVE.HONEY_STAKING,
      data: encodeFunctionData({ abi: stakingAbi, functionName: 'allowManager', args: [ONEHIVE.AGREEMENT, stakeAmount, '0x'] }),
      value: 0n
    });
    await forkClient().waitForTransactionReceipt({ hash: allowHash });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('STAKING_LOCK_ALREADY_EXISTS')) throw error;
    const increaseHash = await wallet.sendTransaction({
      account,
      to: ONEHIVE.HONEY_STAKING,
      data: encodeFunctionData({ abi: stakingAbi, functionName: 'increaseLockAllowance', args: [ONEHIVE.AGREEMENT, stakeAmount] }),
      value: 0n
    });
    await forkClient().waitForTransactionReceipt({ hash: increaseHash });
  }
}
