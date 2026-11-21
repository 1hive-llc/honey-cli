import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function envNames(source: string): string[] {
  return Array.from(source.matchAll(/^([A-Z0-9_]+)=/gm), (match) => match[1] as string);
}

describe('environment example files', () => {
  it('keeps .env.example focused on user setup knobs', () => {
    const starter = read('.env.example');
    const names = envNames(starter);

    expect(names).toEqual(['THE_GRAPH_API_KEY', 'AGENT_WALLET_ADDRESS', 'GNOSIS_RPC_URL']);
    expect(starter).toContain('.env.advanced.example');
    expect(starter).toContain('.env.protocol.example');
    expect(starter).not.toMatch(/^GRAPH_API_KEY=/m);
    expect(starter).not.toContain('ONEHIVE_CONVICTION_VOTING=');
    expect(starter).not.toContain('CELESTE_XDAI_COURT=');
    expect(starter).not.toContain('HONEYSWAP_ROUTER=');
  });

  it('moves advanced runtime settings out of the starter env file', () => {
    const advanced = read('.env.advanced.example');

    expect(advanced).toContain('RUN_FORK_E2E=0');
    expect(advanced).toContain('HONEY_KEYSTORE_DIR=.pi/keystore');
    expect(advanced).toContain('HONEY_SIGNER_URL=http://127.0.0.1:19777');
    expect(advanced).not.toContain('WALLETCONNECT_');
    expect(advanced).toContain('GRAPH_API_KEY is still accepted by code as a legacy alias');
  });

  it('moves protocol address overrides out of the starter env file', () => {
    const protocol = read('.env.protocol.example');

    expect(protocol).toContain('ONEHIVE_CONVICTION_VOTING=0x0b21081c6f8b1990f53fc76279cc41ba22d7afe2');
    expect(protocol).toContain('CELESTE_XDAI_COURT=0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85');
    expect(protocol).toContain('HONEYSWAP_ROUTER=0x1C232F01118CB8B424793ae03F870aa7D0ac7f77');
    expect(protocol).toContain('Most users should not copy this file');
  });
});
