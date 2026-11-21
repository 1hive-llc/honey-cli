import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { HONEYSWAP } from '../../src/onehive/addresses.js';
import { createEncryptedKeystore, decryptKeystore, listKeystores, resolveKeystore } from '../../src/onehive/keystore.js';
import { buildKeystorePolicyPreset, evaluateKeystorePolicy, loadKeystorePolicy } from '../../src/onehive/keystore-policy.js';
import { buildTxPreview } from '../../src/onehive/clients/tx.js';
import type { HexAddress, HexData } from '../../src/onehive/schemas.js';

const privateKey = `0x${'0123456789abcdef'.repeat(4)}` as HexData;
const address = '0xFCAd0B19bB29D4674531d6f115237E16AfCE377c' as HexAddress;

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'onehive-keystore-'));
}

describe('encrypted keystore', () => {
  it('creates, lists, resolves, and decrypts metadata without exposing private key in list output', async () => {
    const dir = await tempDir();
    const created = await createEncryptedKeystore({ dir, label: 'bot', privateKey, passphrase: 'correct horse' });

    expect(created).toMatchObject({ label: 'bot', address });
    const listed = await listKeystores(dir);
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(privateKey.slice(2));
    expect(await resolveKeystore('bot', dir)).toMatchObject({ address });

    const decrypted = await decryptKeystore(created.path, 'correct horse');
    expect(decrypted).toMatchObject({ address, label: 'bot', privateKey });
  });

  it('rejects wrong passphrases and expected-address mismatches', async () => {
    const dir = await tempDir();
    const created = await createEncryptedKeystore({ dir, label: 'bot', privateKey, passphrase: 'correct horse' });

    await expect(decryptKeystore(created.path, 'wrong')).rejects.toThrow(/Failed to decrypt keystore/);
    await expect(createEncryptedKeystore({ dir, label: 'bad', privateKey, passphrase: 'correct horse', expectedAddress: '0x0000000000000000000000000000000000000001' })).rejects.toThrow(/does not match expected address/);
  });

  it('builds a default safe automation policy that allows support/unsupport and heartbeat only', () => {
    const policy = buildKeystorePolicyPreset({ address, label: 'bot', preset: 'safe-automation' });

    expect(policy.accounts[0]).toMatchObject({
      label: 'bot',
      address,
      allowedChainIds: [100],
      maxValueWei: '0',
      maxRisk: 'medium'
    });
    expect(policy.accounts[0]?.allowedMethods).toEqual(expect.arrayContaining(['stakeToProposal', 'withdrawFromProposal', 'heartbeat']));
    expect(policy.accounts[0]?.allowedMethods).not.toEqual(expect.arrayContaining(['addProposal', 'challengeAction']));
  });

  it('builds full-governance and full-access presets', () => {
    const governance = buildKeystorePolicyPreset({ address, label: 'bot', preset: 'full-governance' });
    expect(governance.accounts[0]?.allowedMethods).toEqual(expect.arrayContaining(['addProposal', 'challengeAction', 'createAppeal']));
    expect(governance.accounts[0]?.allowedMethods).not.toEqual(expect.arrayContaining(['transfer', 'swapExactTokensForTokens']));
    expect(governance.accounts[0]?.maxRisk).toBe('critical');

    const fullAccess = buildKeystorePolicyPreset({ address, label: 'bot', preset: 'full-access' });
    expect(fullAccess.accounts[0]?.allowedMethods).toBeUndefined();
    expect(fullAccess.accounts[0]?.allowedSelectors).toBeUndefined();
    expect(fullAccess.accounts[0]?.maxValueWei).toBeUndefined();
    expect(fullAccess.accounts[0]?.maxRisk).toBe('critical');
  });

  it('loads and evaluates explicit keystore policies', async () => {
    const dir = await tempDir();
    const path = join(dir, 'policy.json');
    await writeFile(path, JSON.stringify({ version: 1, accounts: [{ label: 'bot', address, allowedChainIds: [100], allowedTargets: [HONEYSWAP.ROUTER], allowedSelectors: ['0x38ed1739'], allowedMethods: ['swapExactTokensForTokens'], maxValueWei: '0', maxRisk: 'high' }] }), 'utf8');
    const policy = await loadKeystorePolicy(path);
    const tx = buildTxPreview({ chainId: 100, from: address, to: HONEYSWAP.ROUTER, data: '0x38ed1739' as HexData, contractName: 'HoneyswapRouter02', method: 'swapExactTokensForTokens', args: {}, humanSummary: 'Swap', risk: 'high' });

    expect(evaluateKeystorePolicy({ policy, tx, account: address }).every((check) => check.status === 'pass')).toBe(true);

    const wrongTarget = { ...tx, to: '0x0000000000000000000000000000000000000001' as HexAddress };
    expect(evaluateKeystorePolicy({ policy, tx: wrongTarget, account: address })).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'keystore-target', status: 'fail' })]));
    expect(await readFile(path, 'utf8')).not.toContain(privateKey.slice(2));
  });
});
