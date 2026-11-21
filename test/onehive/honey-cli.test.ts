import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildDispatch, runHoneyCli } from '../../src/honey-cli.js';

function capture() {
  let stdout = '';
  let stderr = '';
  return {
    io: {
      stdout: { write(chunk: string) { stdout += chunk; return true; } },
      stderr: { write(chunk: string) { stderr += chunk; return true; } }
    },
    get stdout() { return stdout; },
    get stderr() { return stderr; }
  };
}

const TEST_SALT = '0x1111111111111111111111111111111111111111111111111111111111111111';

describe('Honey CLI dispatch', () => {
  it('does not import the Pi extension adapter', () => {
    const source = readFileSync('src/honey-cli.ts', 'utf8');

    expect(source).not.toContain("extensions/onehive/index");
    expect(source).toContain("./onehive/index.js");
  });

  it('maps Honey token balance to context resolve with balance owner', () => {
    const dispatch = buildDispatch(['token', 'balance', '0x0000000000000000000000000000000000000001']);

    expect(dispatch.toolName).toBe('onehive_context_resolve');
    expect(dispatch.input).toMatchObject({ chainId: 100, includeBalancesFor: '0x0000000000000000000000000000000000000001' });
  });

  it('maps Honey court commit to internal commit tool with explicit salt', () => {
    const dispatch = buildDispatch(['court', 'commit', '7', '--round', '0', '--outcome', '1', '--salt', TEST_SALT]);

    expect(dispatch.toolName).toBe('onehive_court_commitTx');
    expect(dispatch.input).toMatchObject({ disputeId: '7', roundId: '0', outcome: '1', salt: TEST_SALT });
    expect(dispatch.input).not.toHaveProperty('password');
  });

  it('rejects Honey court keeper password flags', () => {
    expect(() => buildDispatch(['court', 'commit', '7', '--round', '0', '--outcome', '1', '--password', 'secret'])).toThrow(/--password keeper-secret path has been removed/);
    expect(() => buildDispatch(['court', 'reveal', '7', '--round', '0', '--outcome', '1', '--password', 'secret'])).toThrow(/--password keeper-secret path has been removed/);
  });

  it('maps Honey court rewards and claim-rewards to internal tools', () => {
    const rewards = buildDispatch(['court', 'rewards', '7', '--juror', '0x0000000000000000000000000000000000000001']);
    const claim = buildDispatch(['court', 'claim-rewards', '7', '--round', '1']);

    expect(rewards.toolName).toBe('onehive_court_rewards');
    expect(rewards.input).toMatchObject({ disputeId: '7', juror: '0x0000000000000000000000000000000000000001' });
    expect(claim.toolName).toBe('onehive_court_claimRewardsTx');
    expect(claim.input).toMatchObject({ disputeId: '7', roundId: '1' });
  });

  it('maps Honey court appeal to internal appeal tool', () => {
    const dispatch = buildDispatch(['court', 'appeal', '7', '--ruling', '1', '--confirm']);

    expect(dispatch.toolName).toBe('onehive_court_appealTx');
    expect(dispatch.input).toMatchObject({ disputeId: '7', ruling: '1', confirm: true });
  });

  it('maps Honey court reveal to internal reveal tool with explicit salt', () => {
    const dispatch = buildDispatch(['court', 'reveal', '7', '--round', '0', '--outcome', '1', '--salt', TEST_SALT]);

    expect(dispatch.toolName).toBe('onehive_court_revealTx');
    expect(dispatch.input).toMatchObject({ disputeId: '7', roundId: '0', outcome: '1', salt: TEST_SALT });
    expect(dispatch.input).not.toHaveProperty('password');
  });

  it('maps Honey court staking actions to internal court tools', () => {
    const stake = buildDispatch(['court', 'stake', '--amount', '100', '--from', '0x0000000000000000000000000000000000000001']);
    const activate = buildDispatch(['court', 'activate', '--amount', '50']);

    expect(stake.toolName).toBe('onehive_court_stakeTx');
    expect(stake.input).toMatchObject({ amountHny: '100', from: '0x0000000000000000000000000000000000000001' });
    expect(activate.toolName).toBe('onehive_court_activateTx');
    expect(activate.input).toMatchObject({ amountHny: '50' });
  });

  it('maps Honey court subgraph status health flags', () => {
    const dispatch = buildDispatch(['court', 'subgraph', 'status', '--max-indexed-age-seconds', '3600', '--celeste-subgraph-url', 'https://example.test/celeste']);

    expect(dispatch.toolName).toBe('onehive_court_subgraphStatus');
    expect(dispatch.input).toMatchObject({ maxIndexedAgeSeconds: 3600, celesteSubgraphUrl: 'https://example.test/celeste' });
  });

  it('maps Honey court heartbeat to the internal heartbeat tool', () => {
    const dispatch = buildDispatch(['court', 'heartbeat', '--max-transitions', '20', '--from', '0x0000000000000000000000000000000000000001']);

    expect(dispatch.toolName).toBe('onehive_court_heartbeatTx');
    expect(dispatch.input).toMatchObject({ maxTransitions: 20, from: '0x0000000000000000000000000000000000000001' });
  });

  it('maps Honey proposal list to the canonical Honey DAO proposals tool', () => {
    const dispatch = buildDispatch(['proposals', 'list', '--status', 'active,challenged', '--limit', '5']);

    expect(dispatch.toolName).toBe('onehive_honey_proposals_list');
    expect(dispatch.input).toMatchObject({ chainId: 100, first: 5, statuses: ['active', 'challenged'] });
    expect(dispatch.input.dao).toBeTruthy();
  });

  it('maps Honey proposal forecast to the forecast tool', () => {
    const dispatch = buildDispatch(['proposals', 'forecast', '213', '--block-time', '5']);

    expect(dispatch.toolName).toBe('onehive_honey_proposal_forecast');
    expect(dispatch.input).toMatchObject({ proposalId: '213', averageBlockTimeSeconds: 5 });
  });

  it('maps Honey proposal stake to the internal governance tool', () => {
    const dispatch = buildDispatch(['proposals', 'stake', '213', '--amount', '10', '--chain', '100']);

    expect(dispatch.toolName).toBe('onehive_governance_stakeTx');
    expect(dispatch.input).toMatchObject({ proposalId: '213', amountHny: '10', chainId: 100 });
  });

  it('rejects removed mobile wallet commands', () => {
    expect(() => buildDispatch(['wc','sessions'])).toThrow();
    expect(() => buildDispatch(['walletconnect','pair'])).toThrow();
    expect(() => buildDispatch(['submit','--walletconnect'],{stdin:'{}'})).toThrow(/not supported/);
  });

  it('maps Honey submit to confirmation-gated tx submission input from stdin with unsigned Safe default', () => {
    const preview = {
      chainId: 100,
      to: '0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85',
      value: '0',
      data: '0x1234',
      decoded: { contractName: 'CelesteCourt', method: 'heartbeat', args: {}, humanSummary: 'heartbeat' },
      simulation: { status: 'success' },
      policy: { risk: 'medium', requiresConfirmation: true, confirmationPhrase: 'SUBMIT heartbeat', checks: [] }
    };
    const dispatch = buildDispatch(['submit', '--confirm', 'SUBMIT heartbeat'], { stdin: JSON.stringify({ ok: true, data: preview }) });

    expect(dispatch.toolName).toBe('onehive_tx_submit');
    expect(dispatch.input).toMatchObject({ confirmationPhrase: 'SUBMIT heartbeat', signerMode: 'safe' });
    expect(dispatch.input.tx).toMatchObject({ decoded: { method: 'heartbeat' } });
  });

  it('maps Honey submit to explicit Safe handoff', () => {
    const dispatch = buildDispatch(['submit', '--safe', '--confirm', 'SUBMIT heartbeat'], { stdin: JSON.stringify({ chainId: 100, to: '0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85', value: '0', data: '0x1234', decoded: { contractName: 'CelesteCourt', method: 'heartbeat', args: {}, humanSummary: 'heartbeat' }, simulation: { status: 'success' }, policy: { risk: 'medium', requiresConfirmation: true, confirmationPhrase: 'SUBMIT heartbeat', checks: [] } }) });

    expect(dispatch.input).toMatchObject({ signerMode: 'safe' });
  });

  it('maps Honey submit to encrypted keystore signer mode without passphrase fields', () => {
    const preview = {
      chainId: 100,
      from: '0x1111111111111111111111111111111111111111',
      to: '0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85',
      value: '0',
      data: '0x1234',
      decoded: { contractName: 'CelesteCourt', method: 'heartbeat', args: {}, humanSummary: 'heartbeat' },
      simulation: { status: 'success' },
      policy: { risk: 'medium', requiresConfirmation: true, confirmationPhrase: 'SUBMIT heartbeat', checks: [] }
    };
    const dispatch = buildDispatch(['submit', '--keystore', '--keystore-account', 'heartbeat-bot', '--confirm', 'SUBMIT heartbeat'], { stdin: JSON.stringify(preview) });

    expect(dispatch.toolName).toBe('onehive_tx_submit');
    expect(dispatch.input).toMatchObject({ confirmationPhrase: 'SUBMIT heartbeat', signerMode: 'keystore', keystoreAccount: 'heartbeat-bot' });
    expect(dispatch.input).not.toHaveProperty('passphrase');
    expect(dispatch.input).not.toHaveProperty('privateKey');
  });

  it('maps Honey submit to external signer modes', () => {
    const preview = { chainId: 100, to: '0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85', value: '0', data: '0x1234', decoded: { contractName: 'CelesteCourt', method: 'heartbeat', args: {}, humanSummary: 'heartbeat' }, simulation: { status: 'success' }, policy: { risk: 'medium', requiresConfirmation: true, confirmationPhrase: 'SUBMIT heartbeat', checks: [] } };
    const dispatch = buildDispatch(['submit', '--signer-daemon', '--signer-url', 'http://127.0.0.1:19777', '--confirm', 'SUBMIT heartbeat'], { stdin: JSON.stringify(preview) });

    expect(dispatch.input).toMatchObject({ signerMode: 'signer-daemon', externalSignerUrl: 'http://127.0.0.1:19777' });
  });

  it('reports signer manager status without requiring secrets', async () => {
    const output = capture();
    const code = await runHoneyCli(['signer', 'status', '--pid-file', '/tmp/nonexistent-honey-signer.pid', '--json'], output.io);

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout);
    expect(parsed.data).toMatchObject({ running: false, pidFile: '/tmp/nonexistent-honey-signer.pid' });
  });

  it('creates keystore policy preset previews', async () => {
    const safe = capture();
    const safeCode = await runHoneyCli(['keystore', 'default-policy', '--account', '0x9579BBb1d5709bdB5E0844875813A292d8b3601a', '--label', 'testing-funded-wallet', '--json'], safe.io);
    expect(safeCode).toBe(0);
    const safeParsed = JSON.parse(safe.stdout);
    expect(safeParsed.data.policy.accounts[0].allowedMethods).toContain('stakeToProposal');
    expect(safeParsed.data.policy.accounts[0].allowedMethods).not.toContain('addProposal');
    expect(safeParsed.data.policy.accounts[0].allowedMethods).not.toContain('challengeAction');

    const governance = capture();
    const governanceCode = await runHoneyCli(['keystore', 'default-policy', '--preset', 'full-governance', '--account', '0x9579BBb1d5709bdB5E0844875813A292d8b3601a', '--json'], governance.io);
    expect(governanceCode).toBe(0);
    const governanceParsed = JSON.parse(governance.stdout);
    expect(governanceParsed.data.policy.accounts[0].allowedMethods).toContain('addProposal');
    expect(governanceParsed.data.policy.accounts[0].allowedMethods).toContain('challengeAction');
    expect(governanceParsed.data.policy.accounts[0].allowedMethods).not.toContain('transfer');

    const fullAccess = capture();
    const fullAccessCode = await runHoneyCli(['keystore', 'default-policy', '--preset', 'full-access', '--account', '0x9579BBb1d5709bdB5E0844875813A292d8b3601a', '--json'], fullAccess.io);
    expect(fullAccessCode).toBe(0);
    const fullAccessParsed = JSON.parse(fullAccess.stdout);
    expect(fullAccessParsed.data.policy.accounts[0].allowedMethods).toBeUndefined();
  });

  it('rejects keystore passphrase and private-key CLI args', () => {
    expect(() => buildDispatch(['submit', '--keystore', '--passphrase', 'secret', '--confirm', 'x'], { stdin: '{}' })).toThrow(/must not be supplied in CLI arguments/);
  });

  it('does not expose GitHub PR tools through raw dispatch', async () => {
    const output = capture();
    const code = await runHoneyCli(['tool', 'github_pr_prepare', '{}', '--json'], output.io);

    expect(code).toBe(1);
    expect(output.stderr).toContain('Unknown tool github_pr_prepare');
  });
});
