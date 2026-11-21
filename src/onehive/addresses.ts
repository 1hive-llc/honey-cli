import { readFileSync } from 'node:fs';
import type { HexAddress } from './schemas.js';

export const CHAINS = {
  gnosis: {
    id: 100,
    name: 'Gnosis Chain',
    nativeCurrency: 'xDAI',
    rpcEnv: 'GNOSIS_RPC_URL',
    explorerEnv: 'GNOSIS_EXPLORER'
  },
  chiado: {
    id: 10200,
    name: 'Chiado Testnet',
    nativeCurrency: 'xDAI',
    rpcEnv: 'CHIADO_RPC_URL',
    explorerEnv: 'CHIADO_EXPLORER'
  },
  localFork: {
    id: 31337,
    name: 'Local Gnosis Fork',
    nativeCurrency: 'xDAI',
    rpcEnv: 'FORK_RPC_URL',
    explorerEnv: 'FORK_EXPLORER'
  }
} as const;

export const TOKENS = {
  HNY: '0x71850b7E9Ee3f13Ab46d67167341E4bDc905Eef9',
  HNY_MAINNET_ETH: '0xc3589F56B6869824804A5EA29F2c9886Af1B0FcE',
  WXDAI: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d'
} as const satisfies Record<string, HexAddress>;

export const HONEYSWAP = {
  FACTORY: '0xA818b4F111Ccac7AA31D0BCc0806d64F2E0737D7',
  ROUTER: '0x1C232F01118CB8B424793ae03F870aa7D0ac7f77'
} as const satisfies Record<string, HexAddress>;

export const ONEHIVE = {
  DAO_KERNEL: '0x8ccbeab14b5ac4a431fffc39f4bec4089020a155',
  ACL: '0xbc4fb635636b81e60a4e356c4dceb53cac507d03',
  CONVICTION_VOTING: '0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2',
  DISPUTABLE_VOTING: '0xfbd0b2726070a9d6aff6d7216c9e9340eae68b2a',
  AGREEMENT: '0x59a15718992a42082ab2306bc6cbd662958a178c',
  HOOKED_TOKEN_MANAGER: '0xed062e26c8f41a9088d060156edc7fc6c17d5825',
  AGENT_VAULT: '0x4ba7362f9189572cbb1216819a45aba0d0b2d1cb',
  HONEY_STAKING: '0x0e25b918c9fb2fea5d42011d1f4b9f8c61b453e7',
  PRICE_ORACLE: '0x6f38D112b13eda1E3abAFC61E296Be2E27F15071',
  FEES_UPDATER: '0xeb24f7001437188baF2D5Ef0b0FcFadAD4564517',
  COLLATERAL_UPDATER: '0xc08fbc829A879470C15916Aad14e85905E6Ab901'
} as const satisfies Record<string, HexAddress>;

export const CELESTE = {
  COURT: '0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85',
  DISPUTE: '0xeC7904e20b69F60966D6c6b9DC534355614dd922',
  REGISTRY: '0x8C9968a2b16bc1cD0eaD74F5eeF25E899e795501',
  TREASURY: '0xeac1dc5ccF09E2b816F9544878CD513728Fa6af7',
  SUBSCRIPTIONS: '0x4e4EA6845d7656d569DC4CCC7b68Bb3023720837'
} as const satisfies Record<string, HexAddress>;

export const CELESTE_UNVERIFIED = {
  VOTING_WIKI_TRUNCATED: '0x1a0d15f1f6d90C2b71EbA3859a1F30c91E5af9b'
} as const;

export const ALLOWLISTED_WRITE_TARGETS = new Set<HexAddress>([
  ONEHIVE.CONVICTION_VOTING,
  ONEHIVE.DISPUTABLE_VOTING,
  ONEHIVE.AGREEMENT,
  ONEHIVE.PRICE_ORACLE,
  ONEHIVE.FEES_UPDATER,
  ONEHIVE.COLLATERAL_UPDATER,
  CELESTE.COURT,
  CELESTE.REGISTRY,
  TOKENS.HNY,
  TOKENS.WXDAI,
  HONEYSWAP.ROUTER
]);

const ALLOWLISTED_WRITE_TARGETS_LOWERCASE = new Set<string>(
  Array.from(ALLOWLISTED_WRITE_TARGETS, (address) => address.toLowerCase())
);

export function isAllowlistedWriteTarget(address: HexAddress, additionalAllowlistedTargets: Iterable<HexAddress> = []): boolean {
  const normalized = address.toLowerCase();
  if (ALLOWLISTED_WRITE_TARGETS_LOWERCASE.has(normalized)) return true;
  for (const additional of additionalAllowlistedTargets) {
    if (additional.toLowerCase() === normalized) return true;
  }
  return false;
}

type AddressReferenceFile = {
  tokens?: Record<string, string | null>;
  honeyswap?: Record<string, string | null>;
  onehive?: Record<string, string | null>;
  celeste?: Record<string, string | null>;
};

type AddressReferenceSection = keyof AddressReferenceFile;

const addressReferenceUrl = new URL('../../references/onehive-addresses.json', import.meta.url);
let cachedReferences: AddressReferenceFile | undefined;

export function isReferenceHexAddress(value: unknown): value is HexAddress {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value);
}

export function loadAddressReferences(): AddressReferenceFile {
  if (cachedReferences) return cachedReferences;
  try {
    cachedReferences = JSON.parse(readFileSync(addressReferenceUrl, 'utf8')) as AddressReferenceFile;
  } catch {
    cachedReferences = {};
  }
  return cachedReferences;
}

export function referenceAddress(section: AddressReferenceSection, key: string, fallback: HexAddress): HexAddress {
  const value = loadAddressReferences()[section]?.[key];
  return isReferenceHexAddress(value) ? value : fallback;
}

export function addressFromEnv(name: string, fallback: HexAddress): HexAddress {
  const value = process.env[name];
  if (isReferenceHexAddress(value)) return value;
  return fallback;
}

export function addressFromEnvOrReference(name: string, section: AddressReferenceSection, key: string, fallback: HexAddress): HexAddress {
  return addressFromEnv(name, referenceAddress(section, key, fallback));
}
