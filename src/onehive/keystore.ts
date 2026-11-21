import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, readdir, stat, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { readSecretFromTty } from './secret-input.js';
import type { HexAddress, HexData } from './schemas.js';

const DEFAULT_KEYSTORE_DIR = '.pi/keystore';

export type EncryptedKeystoreFile = {
  version: 1;
  address: HexAddress;
  label: string;
  createdAt: string;
  crypto: {
    kdf: 'scrypt';
    salt: string;
    n: number;
    r: number;
    p: number;
    dkLen: number;
    cipher: 'aes-256-gcm';
    iv: string;
    tag: string;
    ciphertext: string;
  };
};

export type KeystoreMetadata = Pick<EncryptedKeystoreFile, 'version' | 'address' | 'label' | 'createdAt'> & { path: string; permissionsWarning?: string };

export type KeystoreCreateInput = {
  privateKey?: HexData;
  label: string;
  passphrase: string;
  expectedAddress?: HexAddress;
  dir?: string;
  now?: Date;
};

function keystoreDir(dir?: string): string {
  return dir ?? process.env.HONEY_KEYSTORE_DIR ?? DEFAULT_KEYSTORE_DIR;
}

function assertPrivateKey(privateKey: string): asserts privateKey is HexData {
  if (!/^0x[a-fA-F0-9]{64}$/.test(privateKey)) throw new Error('Private key must be a 0x-prefixed 32-byte hex string.');
}

function assertPassphrase(passphrase: string): void {
  if (!passphrase) throw new Error('Keystore passphrase is required.');
}

function safeName(label: string, address: HexAddress): string {
  const base = label.trim().replace(/[^a-z0-9._-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 64) || address;
  return `${base}-${address.slice(2, 10).toLowerCase()}.json`;
}

async function deriveKey(passphrase: string, salt: Buffer, params?: { n?: number; r?: number; p?: number; dkLen?: number }): Promise<Buffer> {
  const n = params?.n ?? 16384;
  const r = params?.r ?? 8;
  const p = params?.p ?? 1;
  const dkLen = params?.dkLen ?? 32;
  return await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(passphrase, salt, dkLen, { N: n, r, p }, (error, derivedKey) => {
      if (error) reject(error);
      else resolve(derivedKey as Buffer);
    });
  });
}

function addressFromPrivateKey(privateKey: HexData): HexAddress {
  return privateKeyToAccount(privateKey).address as HexAddress;
}

function constantTimeAddressEqual(a: HexAddress, b: HexAddress): boolean {
  const left = Buffer.from(a.toLowerCase());
  const right = Buffer.from(b.toLowerCase());
  return left.length === right.length && timingSafeEqual(left, right);
}

export function getKeystoreDir(dir?: string): string {
  return keystoreDir(dir);
}

export async function createEncryptedKeystore(input: KeystoreCreateInput): Promise<KeystoreMetadata> {
  assertPassphrase(input.passphrase);
  const privateKey = input.privateKey ?? generatePrivateKey();
  assertPrivateKey(privateKey);
  const address = addressFromPrivateKey(privateKey);
  if (input.expectedAddress && !constantTimeAddressEqual(address, input.expectedAddress)) throw new Error(`Private key does not match expected address ${input.expectedAddress}.`);
  const label = input.label.trim();
  if (!label) throw new Error('Keystore label is required.');

  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = await deriveKey(input.passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  key.fill(0);

  const file: EncryptedKeystoreFile = {
    version: 1,
    address,
    label,
    createdAt: (input.now ?? new Date()).toISOString(),
    crypto: {
      kdf: 'scrypt',
      salt: salt.toString('hex'),
      n: 16384,
      r: 8,
      p: 1,
      dkLen: 32,
      cipher: 'aes-256-gcm',
      iv: iv.toString('hex'),
      tag: tag.toString('hex'),
      ciphertext: ciphertext.toString('hex')
    }
  };
  const dir = keystoreDir(input.dir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, safeName(label, address));
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try { await chmod(path, 0o600); } catch { /* best effort for non-POSIX filesystems */ }
  return { version: file.version, address, label, createdAt: file.createdAt, path };
}

function validateFile(file: unknown): EncryptedKeystoreFile {
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error('Invalid keystore file.');
  const candidate = file as EncryptedKeystoreFile;
  if (candidate.version !== 1) throw new Error('Unsupported keystore version.');
  if (!/^0x[a-fA-F0-9]{40}$/.test(candidate.address)) throw new Error('Invalid keystore address.');
  if (!candidate.label) throw new Error('Invalid keystore label.');
  if (candidate.crypto?.kdf !== 'scrypt' || candidate.crypto?.cipher !== 'aes-256-gcm') throw new Error('Unsupported keystore crypto settings.');
  return candidate;
}

export async function readEncryptedKeystore(path: string): Promise<EncryptedKeystoreFile> {
  return validateFile(JSON.parse(await readFile(path, 'utf8')) as unknown);
}

async function permissionsWarning(path: string): Promise<string | undefined> {
  if (process.platform === 'win32') return undefined;
  try {
    const mode = (await stat(path)).mode & 0o777;
    return (mode & 0o077) === 0 ? undefined : `Keystore file permissions are ${mode.toString(8)}; expected 600 or stricter.`;
  } catch {
    return undefined;
  }
}

export async function listKeystores(dir?: string): Promise<KeystoreMetadata[]> {
  const root = keystoreDir(dir);
  let names: string[];
  try { names = await readdir(root); } catch { return []; }
  const items: KeystoreMetadata[] = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const path = join(root, name);
    try {
      const file = await readEncryptedKeystore(path);
      const warning = await permissionsWarning(path);
      items.push({ version: file.version, address: file.address, label: file.label, createdAt: file.createdAt, path, ...(warning ? { permissionsWarning: warning } : {}) });
    } catch {
      // Ignore malformed files when listing metadata.
    }
  }
  return items.sort((a, b) => a.label.localeCompare(b.label));
}

export async function resolveKeystore(identifier: string, dir?: string): Promise<KeystoreMetadata> {
  const items = await listKeystores(dir);
  const lowered = identifier.toLowerCase();
  const match = items.find((item) => item.address.toLowerCase() === lowered || item.label === identifier);
  if (!match) throw new Error(`No encrypted keystore found for ${identifier}.`);
  return match;
}

export async function decryptKeystore(path: string, passphrase: string): Promise<{ address: HexAddress; label: string; privateKey: HexData }> {
  assertPassphrase(passphrase);
  const file = await readEncryptedKeystore(path);
  const warning = await permissionsWarning(path);
  if (warning) throw new Error(warning);
  const salt = Buffer.from(file.crypto.salt, 'hex');
  const key = await deriveKey(passphrase, salt, file.crypto);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(file.crypto.iv, 'hex'));
    decipher.setAuthTag(Buffer.from(file.crypto.tag, 'hex'));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(file.crypto.ciphertext, 'hex')), decipher.final()]).toString('utf8');
    assertPrivateKey(plaintext);
    const derived = addressFromPrivateKey(plaintext);
    if (!constantTimeAddressEqual(derived, file.address)) throw new Error('Decrypted private key does not match keystore address.');
    return { address: file.address, label: file.label, privateKey: plaintext };
  } catch (error) {
    if (error instanceof Error && error.message.includes('does not match')) throw error;
    throw new Error('Failed to decrypt keystore. Check the passphrase and file integrity.');
  } finally {
    key.fill(0);
  }
}

export async function readPassphraseFromFile(path = process.env.HONEY_KEYSTORE_PASSPHRASE_FILE): Promise<string> {
  if (!path) throw new Error('HONEY_KEYSTORE_PASSPHRASE_FILE is required for passphrase-file keystore signing. Passphrases must not be supplied in CLI args or tool JSON.');
  const value = (await readFile(path, 'utf8')).trimEnd();
  assertPassphrase(value);
  return value;
}

export async function readPassphraseInteractively(label: string): Promise<string> {
  const value = await readSecretFromTty({ question: `Enter passphrase for keystore ${label}: ` });
  assertPassphrase(value);
  return value;
}
