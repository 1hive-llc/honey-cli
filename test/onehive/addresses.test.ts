import { describe, expect, it } from 'vitest';
import { CELESTE, HONEYSWAP, ONEHIVE, TOKENS, addressFromEnvOrReference, loadAddressReferences, referenceAddress } from '../../src/onehive/addresses.js';
import { isHexAddress } from '../../src/onehive/policy.js';

describe('address constants', () => {
  it('contains valid token addresses', () => {
    for (const address of Object.values(TOKENS)) {
      expect(isHexAddress(address)).toBe(true);
    }
  });

  it('contains valid Honeyswap addresses', () => {
    for (const address of Object.values(HONEYSWAP)) {
      expect(isHexAddress(address)).toBe(true);
    }
  });

  it('contains valid 1Hive and Celeste addresses', () => {
    for (const address of [...Object.values(ONEHIVE), ...Object.values(CELESTE)]) {
      expect(isHexAddress(address)).toBe(true);
    }
  });

  it('loads address references from references/onehive-addresses.json', () => {
    const references = loadAddressReferences();

    expect(references.tokens?.HNY).toBe(TOKENS.HNY);
    expect(references.honeyswap?.router02).toBe(HONEYSWAP.ROUTER);
    expect(references.celeste?.voting).toBeNull();
  });

  it('uses reference fallback and valid env overrides for address resolution', () => {
    const previous = process.env.ONEHIVE_DAO_KERNEL;
    const override = '0x3333333333333333333333333333333333333333';

    try {
      delete process.env.ONEHIVE_DAO_KERNEL;
      expect(addressFromEnvOrReference('ONEHIVE_DAO_KERNEL', 'onehive', 'daoKernel', ONEHIVE.DAO_KERNEL)).toBe(ONEHIVE.DAO_KERNEL);

      process.env.ONEHIVE_DAO_KERNEL = 'not-an-address';
      expect(addressFromEnvOrReference('ONEHIVE_DAO_KERNEL', 'onehive', 'daoKernel', ONEHIVE.DAO_KERNEL)).toBe(ONEHIVE.DAO_KERNEL);

      process.env.ONEHIVE_DAO_KERNEL = override;
      expect(addressFromEnvOrReference('ONEHIVE_DAO_KERNEL', 'onehive', 'daoKernel', ONEHIVE.DAO_KERNEL)).toBe(override);
    } finally {
      if (previous === undefined) delete process.env.ONEHIVE_DAO_KERNEL;
      else process.env.ONEHIVE_DAO_KERNEL = previous;
    }
  });

  it('falls back when a reference value is nullable or invalid', () => {
    const fallback = '0x4444444444444444444444444444444444444444';

    expect(referenceAddress('celeste', 'voting', fallback)).toBe(fallback);
  });
});
