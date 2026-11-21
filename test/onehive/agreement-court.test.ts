import { custom, encodeAbiParameters, keccak256, parseAbiParameters, toFunctionSelector, zeroAddress } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { helpText, runHoneyCli } from '../../src/honey-cli.js';
import { CELESTE, ONEHIVE } from '../../src/onehive/addresses.js';
import * as chain from '../../src/onehive/clients/chain.js';
import { readAgreementCourtStatus } from '../../src/onehive/tools/agreement-court.js';

const adapter = '0x1111111111111111111111111111111111111111';
const core = '0x2222222222222222222222222222222222222222';
const other = '0x3333333333333333333333333333333333333333';
const localId = 2n ** 100n;
const disputeId = BigInt(keccak256(encodeAbiParameters(parseAbiParameters('address, uint256'), [adapter, 0n])));
const block = 456n;
const baseInput = { chainId: 100, adapter } as const;
const select = { ...baseInput, proposalId: localId.toString() };
const agreement = ONEHIVE.AGREEMENT;

// In-memory JSON-RPC returns independently encoded ABI tuples. All contract reads
// must target the same block, exact contract, selector and argument.
function fixture(overrides: Partial<{
  chain: number; current: string; saved: string; app: string; local: bigint; savedId: bigint; challengeId: bigint; actionId: bigint;
  linkedAction: bigint; state: number; dispute: bigint; ruling: bigint; exists: boolean; finalised: boolean;
  boundAgreement: string; coreSubject: string; failCore: boolean; coreRuled: boolean; adapterRuling: bigint;
}> = {}) {
  const f = { chain: 100, current: adapter, saved: CELESTE.COURT, app: ONEHIVE.CONVICTION_VOTING,
    local: localId, savedId: 1n, challengeId: 12n, actionId: 9n, linkedAction: 9n, state: 2, dispute: 0n, ruling: 0n,
    exists: true, finalised: false, boundAgreement: agreement, coreSubject: adapter, adapterRuling: 3n, coreRuled: overrides.finalised ?? false,
    failCore: false, ...overrides };
  const methods: string[] = [];
  const calls: string[] = [];
  function encoded(types: string, values: readonly unknown[]) {
    return encodeAbiParameters(parseAbiParameters(types), values);
  }
  const client = chain.createViemChainClient({ chainId: 100, transport: custom({
    async request({ method, params }) {
      methods.push(method);
      if (method === 'eth_chainId') return '0x' + f.chain.toString(16);
      if (method === 'eth_blockNumber') return '0x' + block.toString(16);
      if (method !== 'eth_call') throw new Error('Unexpected RPC method');
      const [tx, tag] = params;
      expect(tag).toBe('0x' + block.toString(16));
      function matches(address: string, signature: string, arg?: bigint) {
        const data = toFunctionSelector(signature) + (arg === undefined ? '' : arg.toString(16).padStart(64, '0'));
        if (tx.to.toLowerCase() !== address.toLowerCase() || tx.data !== data) return false;
        calls.push(signature);
        return true;
      }
      if (matches(agreement, 'getCurrentSettingId()')) return encoded('uint256', [2n]);
      if (matches(agreement, 'getSetting(uint256)', 2n)) return encoded('address,address,string,bytes', [f.current, zeroAddress, 'Current covenant', '0xcd']);
      if (matches(agreement, 'getSetting(uint256)', 1n)) return encoded('address,address,string,bytes', [f.saved, other, 'Original covenant', '0xab']);
      if (matches(ONEHIVE.CONVICTION_VOTING, 'getProposal(uint256)', localId)) {
        return encoded('uint256,bool,address,uint256,uint256,uint64,uint256,uint8,address,uint256', [0n, false, other, 0n, 0n, 0n, f.actionId, 0, other, 0n]);
      }
      if (matches(ONEHIVE.DISPUTABLE_VOTING, 'getVote(uint256)', localId)) {
        return encoded('uint256,uint256,uint256,uint64,uint64,uint8,uint256,uint256,uint64,uint64,uint64,uint8,bytes32',
          [0n, 0n, 0n, 0n, 0n, 0, 51n, f.actionId, 0n, 0n, 0n, 0, '0x' + '00'.repeat(32)]);
      }
      if (matches(agreement, 'getAction(uint256)', 9n)) return encoded('address,uint256,uint256,uint256,address,bool,bytes,uint256,bool',
        [f.app, f.local, 7n, f.savedId, other, false, '0x', f.challengeId, f.challengeId > 0n && [0, 2].includes(f.state)]);
      if (matches(agreement, 'getChallenge(uint256)', 12n)) return encoded('uint256,address,uint64,bytes,uint256,uint8,bool,bool,uint256,uint256',
        [f.linkedAction, other, 777n, '0x', 0n, f.state, false, false, f.dispute, f.ruling]);
      if (matches(adapter, 'agreement()')) return encoded('address', [f.boundAgreement]);
      if (matches(adapter, 'core()')) return encoded('address', [core]);
      if (matches(adapter, 'disputes(uint256)', f.dispute)) return encoded('uint256,uint256,bool,bool', [0n, f.finalised ? f.adapterRuling : 0n, f.exists, f.finalised]);
      if (matches(core, 'disputes(uint256)', 0n) && !f.failCore) return encoded('uint96,address,uint8,bool,uint256', [7n, f.coreSubject, f.finalised ? 4 : 3, f.coreRuled, 0n]);
      throw new Error('Mock RPC getter unavailable (private-endpoint-marker)');
    }
  }, { retryCount: 0 }) });
  return { client, calls, methods };
}

afterEach(() => vi.restoreAllMocks());

async function cli(args: string[], client: chain.ChainClient) {
  vi.spyOn(chain, 'createChainClientFromEnv').mockReturnValue(client);
  let stdout = '', stderr = '';
  const code = await runHoneyCli(['disputes', 'status', ...args, '--json'], {
    stdout: { write(chunk: string) { stdout += chunk; return true; } },
    stderr: { write(chunk: string) { stderr += chunk; return true; } }
  });
  expect(stderr).toBe('');
  return { code, json: JSON.parse(stdout) };
}

describe('Agreement court status', () => {
  it('prints one stable JSON object for a Conviction action under the previous Celeste setting', async () => {
    const rpc = fixture();
    const { code, json } = await cli(['--proposal', localId.toString(), '--adapter', adapter], rpc.client);
    expect(code).toBe(0);
    const warning = 'Setting 1 uses legacy Celeste. Court details are available only for Honey/Kleros.';
    expect(json).toEqual({ ok: true, warnings: [warning], warningDetails: [{ category: 'operator-guidance', severity: 'warning', message: warning }], data: {
      chainId: 100, blockNumber: '456', agreement, currentSetting: { settingId: '2', arbitrator: adapter,
        kind: 'configured-kleros-adapter', aragonAppFeesCashier: zeroAddress, title: 'Current covenant', content: '0xcd' },
      action: { kind: 'conviction', app: ONEHIVE.CONVICTION_VOTING, appId: localId.toString(), actionId: '9', closed: false,
        collateralRequirementId: '7', setting: { settingId: '1', arbitrator: CELESTE.COURT,
          kind: 'legacy-celeste', aragonAppFeesCashier: other, title: 'Original covenant', content: '0xab' },
        challengeState: 'Disputed', latestChallenge: { challengeId: '12', active: true, state: 'Disputed', stateCode: 2,
          disputeId: '0', agreementRuling: null, court: null } } } });
    expect(rpc.calls).toEqual(['getCurrentSettingId()', 'getSetting(uint256)', 'getProposal(uint256)', 'getAction(uint256)', 'getSetting(uint256)', 'getChallenge(uint256)']);
    expect(new Set(rpc.methods)).toEqual(new Set(['eth_blockNumber', 'eth_chainId', 'eth_call']));
    expect(helpText()).toContain('disputes status [--proposal ID | --vote ID]');
  });

  it('reads only the current setting when no action is selected', async () => {
    const rpc = fixture({ current: other });
    const { json, code } = await cli([], rpc.client);
    expect(code).toBe(0);
    expect(json.data).toMatchObject({ currentSetting: { kind: 'unknown', arbitrator: other }, action: null });
    expect(json.warnings[0]).toMatch(/unrecognized arbitrator/);
    expect(rpc.calls).toEqual(['getCurrentSettingId()', 'getSetting(uint256)']);
  });

  it('uses the Decision vote’s Agreement action ID and leaves an unchallenged vote without a dispute', async () => {
    const rpc = fixture({ app: ONEHIVE.DISPUTABLE_VOTING, challengeId: 0n, savedId: 2n });
    const { json } = await cli(['--vote', localId.toString(), '--adapter', adapter], rpc.client);
    expect(json.data.action).toMatchObject({ kind: 'decision', actionId: '9', setting: json.data.currentSetting,
      challengeState: 'Unchallenged', latestChallenge: null });
    expect(rpc.calls).toEqual(['getCurrentSettingId()', 'getSetting(uint256)', 'getVote(uint256)', 'getAction(uint256)']);
  });

  it.each([[0, 'Waiting'], [1, 'Settled'], [7, 'Unknown']] as const)('does not promote default fields at state %i to a dispute or ruling', async (state, label) => {
    const rpc = fixture({ state });
    const result = await readAgreementCourtStatus(select, rpc.client);
    expect(result.data?.action?.latestChallenge).toMatchObject({ state: label, disputeId: null, agreementRuling: null, court: null });
    expect(rpc.calls).not.toContain('disputes(uint256)');
    if (state === 7) expect(result.warnings.join(' ')).toContain('ambiguous');
  });

  it.each([[3, 'Accepted', 4n], [4, 'Rejected', 3n], [5, 'Voided', 2n]] as const)(
    'reads terminal Agreement state %i and its separate stored ruling', async (state, label, ruling) => {
      const result = await readAgreementCourtStatus(select, fixture({ state, ruling, saved: adapter,
        dispute: disputeId, finalised: true, adapterRuling: ruling }).client);
      expect(result.data?.action?.latestChallenge).toMatchObject({ state: label, active: false, disputeId: disputeId.toString(),
        agreementRuling: ruling.toString(), court: { finalised: true, adapterAgreementRuling: ruling.toString() } });
    });

  it.each([false, true])('separates Kleros adapter finality (%s), Core court and Agreement resolution', async finalised => {
    const rpc = fixture({ current: other, saved: adapter, dispute: disputeId, finalised });
    const result = await readAgreementCourtStatus(select, rpc.client);
    expect(result.data?.action?.latestChallenge).toEqual({ challengeId: '12', active: true, stateCode: 2, state: 'Disputed',
      disputeId: disputeId.toString(), agreementRuling: null, court: { core,
        coreDisputeId: '0', currentCourtId: '7', coreRuled: finalised, periodCode: finalised ? 4 : 3, period: finalised ? 'execution' : 'appeal', finalised, adapterAgreementRuling: finalised ? '3' : null } });
  });

  it('flags conflicting finality and ruling observations', async () => {
    const rpc = fixture({ saved: adapter, dispute: disputeId, finalised: true, coreRuled: false, state: 3, ruling: 4n });
    const result = await readAgreementCourtStatus(select, rpc.client);
    expect(result.warnings.join(' ')).toMatch(/different ruling finality.*final ruling disagree/);
  });

  it.each([{ boundAgreement: other }, { exists: false }, { dispute: 123n }])('withholds unlinked adapter data', async override => {
    const result = await readAgreementCourtStatus(select, fixture({ saved: adapter, dispute: disputeId, ...override }).client);
    expect(result.data?.action?.latestChallenge).toMatchObject({ disputeId: (override.dispute ?? disputeId).toString(), court: null });
    expect(result.warnings.join(' ')).toContain('Kleros adapter dispute details are unavailable');
  });

  it.each([{ coreSubject: other }, { failCore: true }])('preserves adapter facts when Core details are unavailable', async override => {
    const result = await readAgreementCourtStatus(select, fixture({ saved: adapter, dispute: disputeId, ...override }).client);
    expect(result.data?.action?.latestChallenge?.court).toMatchObject({ coreDisputeId: '0', currentCourtId: null, period: null });
    expect(result.warnings.join(' ')).toContain('Kleros Core dispute details are unavailable');
    expect(JSON.stringify(result)).not.toContain('private-endpoint-marker');
  });

  it('does not infer a court from a familiar address on another chain', async () => {
    const rpc = fixture({ chain: 31337 });
    const input = { ...select, chainId: 31337 as const };
    const result = await readAgreementCourtStatus(input, rpc.client);
    expect(result.data?.action?.setting.kind).toBe('unknown');
    expect(result.data?.action?.latestChallenge?.court).toBeNull();
    expect(rpc.calls).not.toContain('disputes(uint256)');
  });

  it.each([{ app: other }, { local: 1n }, { linkedAction: 10n }, { actionId: 0n }])('rejects inconsistent Agreement record links', async override => {
    const result = await readAgreementCourtStatus(select, fixture(override).client);
    expect(result.error?.code).toBe('agreement_link_mismatch');
    expect(result.data).toBeUndefined();
  });

  it('reports a wrong RPC chain before any block or contract lookup', async () => {
    const rpc = fixture({ chain: 31337 });
    const { code, json } = await cli([], rpc.client);
    expect(code).toBe(1);
    expect(json).toEqual({ ok: false, warnings: [], warningDetails: [], error: {
      code: 'wrong_chain', message: 'RPC chain 31337 differs from requested chain 100.', retryable: false } });
    expect(rpc.methods).toEqual(['eth_chainId']);
  });

  it.each([['--proposal', '1', '--vote', '2'], ['--proposal'], ['--vote', (2n ** 256n).toString()],
    ['--adapter', CELESTE.COURT], ['--chain', '1'], ['9'], ['--action', '9']])('rejects invalid or ambiguous input before RPC (%s)', async (...args) => {
    const rpc = fixture();
    const { json, code } = await cli(args, rpc.client);
    expect(code).toBe(1);
    expect(json.ok).toBe(false);
    expect(rpc.methods).toEqual([]);
  });
});
