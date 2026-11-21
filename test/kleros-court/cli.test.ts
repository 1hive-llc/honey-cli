import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, zeroAddress, zeroHash } from 'viem';
import { afterAll, describe, expect, it } from 'vitest';
import { agreementAbi, agreementResolutionAbi } from '../../src/onehive/abis/agreement.js';
import { convictionVotingAbi } from '../../src/onehive/abis/convictionVoting.js';
import { disputableVotingAbi } from '../../src/onehive/abis/disputableVoting.js';
import { erc20Abi } from '../../src/onehive/abis/erc20.js';
import { CELESTE } from '../../src/onehive/addresses.js';
import { sortitionAbi } from '../../src/kleros-court/abis.js';
import { adapter, agreement, agreementId, app, base, caseFixture, caseRequest, core, honey, juror, module, other,
  operator, stakingFixture, type Recording } from './fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'honey-court-bin-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const path = join(dir, 'recording.json');
const stake = { ...base, courtId: '1', targetRaw: '100' };
const keeper = { ...caseRequest, from: operator };
const delivered = () => caseFixture({ id: 0n, period: 4, finalised: true, ruling: 4n });

function bin(args: string[], request: unknown, rpc?: 'hash' | 'number' | 'latest') {
  const preload = rpc ? ['--import', './test/kleros-court/mock-rpc.mjs'] : [];
  const execution = spawnSync(process.execPath, [...preload, 'bin/honey.mjs', ...args, '--json'], {
    encoding: 'utf8', input: JSON.stringify(request), timeout: 10000,
    env: { ...process.env, COURT_TEST_RECORDING: path, COURT_TEST_TAG: rpc, FORK_RPC_URL: 'http://fixture.invalid/',
      ONEHIVE_AGREEMENT: agreement, ONEHIVE_CONVICTION_VOTING: app, ONEHIVE_DISPUTABLE_VOTING: app }
  });
  expect(execution.error).toBeUndefined();
  expect(execution.stderr).toBe('');
  const json = JSON.parse(execution.stdout);
  expect(execution.status).toBe(json.ok ? 0 : 1);
  return json;
}

type Row = [string, string, Recording, Record<string, unknown>, string | null];
const rows: Row[] = [
  ['juror', 'approve-stake', stakingFixture().set(honey, erc20Abi, 'allowance', [juror, core], 0n), stake, 'approve'],
  ['juror', 'clear-stake-allowance', stakingFixture(), base, 'approve'],
  ['juror', 'stake', stakingFixture(), stake, 'setStake'],
  ['juror', 'my-votes', caseFixture(), caseRequest, null],
  ['juror', 'vote', caseFixture(), { ...caseRequest, voteIds: ['2'], choice: 'challenger', justification: 'Fixture.' }, 'castVote'],
  ['juror', 'withdraw-leftover', stakingFixture().set(module, sortitionAbi, 'getJurorLeftoverPNK', [juror], 1n),
    { ...base, beneficiary: juror }, 'withdrawLeftoverPNK'],
  ['keeper', 'pass-phase', stakingFixture().set(module, sortitionAbi, 'phase', [], 1), { ...base, phase: 'generating' }, 'passPhase'],
  ['keeper', 'draw', caseFixture({ period: 0, drawn: [] }), { ...keeper, iterations: '1' }, 'draw'],
  ['keeper', 'pass-period', caseFixture({ period: 0 }), { ...keeper, period: 'evidence' }, 'passPeriod'],
  ['keeper', 'execute-rewards', delivered(), { ...keeper, iterations: '1' }, 'execute'],
  ['keeper', 'execute-ruling', caseFixture({ period: 4 }), keeper, 'executeRuling'],
  ['keeper', 'execute-delayed-stakes', stakingFixture().set(module, sortitionAbi, 'delayedStakeReadIndex', [], 1n)
    .set(module, sortitionAbi, 'delayedStakeWriteIndex', [], 1n), { ...base, iterations: '1' }, 'executeDelayedStakes'],
  ['case', 'settlement', delivered(), keeper, null],
  ['disputes', 'resolve', delivered(), keeper, 'resolve']
];

describe('installed Honey command', () => {
  it.each(rows)('%s %s replays its block through the public executable', (group, command, recording, request, method) => {
    writeFileSync(path, JSON.stringify(recording.json()));
    const route = group === 'disputes' ? [group, command] : ['kleros', group, command];
    const output = bin([...route, '--snapshot', path], request);
    expect(output.ok, JSON.stringify(output.error)).toBe(true);
    expect(output.data.block).toMatchObject({ blockNumber: '450', blockHash: recording.json().blockHash });
    if (method) expect(output.data.preview).toMatchObject({ from: request.from, value: '0', decoded: { method },
      simulation: { status: 'not-run' }, policy: { checks: expect.arrayContaining([{ name: 'abi-lock', status: 'fail', detail: expect.any(String) }]) } });
    else expect(output.data.preview).toBeUndefined();
    if (command === 'my-votes') expect(output.data.seats.map((seat: { voteId: string }) => seat.voteId)).toEqual(['0', '2']);
    if (command === 'resolve') expect(output.data.preview).toMatchObject({ to: agreement,
      decoded: { args: { disputeId: agreementId(0n).toString() } }, policy: { risk: 'critical' } });
  });

  it('captures only the required hash-pinned getters, then replays the capture envelope without a transport', () => {
    const full = delivered().json();
    writeFileSync(path, JSON.stringify(full));
    const captured = bin(['kleros', 'capture', 'resolve', '--block', full.blockNumber], keeper, 'hash');
    expect(captured.ok, JSON.stringify(captured.error)).toBe(true);
    expect(captured.data.calls.length).toBeGreaterThan(0);
    expect(captured.data.calls.length).toBeLessThan(full.calls.length);
    expect(captured.data.blockHash).toBe(full.blockHash);
    writeFileSync(path, JSON.stringify(captured));
    const result = bin(['disputes', 'resolve', '--snapshot', path], keeper);
    expect(result).toEqual(delivered().run('resolve', keeper));
  });

  it('rejects missing or retired saved bindings even when the current setting points to the expected adapter', () => {
    for (const saved of [other, CELESTE.COURT]) {
      const recording = delivered().set(agreement, agreementResolutionAbi, 'getSetting', [5n], [saved, zeroAddress, '', '0x'])
        .set(agreement, agreementAbi, 'getCurrentSettingId', [], 6n)
        .set(agreement, agreementResolutionAbi, 'getSetting', [6n], [adapter, zeroAddress, '', '0x']).json();
      writeFileSync(path, JSON.stringify(recording));
      expect(bin(['disputes', 'resolve', '--snapshot', path], keeper).error.code).toBe('court_precondition');
      if (saved === CELESTE.COURT) {
        expect(bin(['disputes', 'resolve', '--snapshot', path], { ...keeper, adapter: saved }).error.code).toBe('court_precondition');
      }
    }
    const old = delivered().json();
    const getter = encodeFunctionData({ abi: agreementResolutionAbi, functionName: 'getSetting', args: [5n] });
    old.calls = old.calls.filter(call => call.to !== agreement || call.data !== getter);
    writeFileSync(path, JSON.stringify(old));
    expect(bin(['disputes', 'resolve', '--snapshot', path], keeper).error).toMatchObject({
      code: 'court_missing_read', details: { method: 'getSetting', to: agreement, data: getter } });
  });

  it('rejects a wrong group, a second resolve path, command override and submission flags', () => {
    writeFileSync(path, JSON.stringify(delivered().json()));
    expect(bin(['kleros', 'case', 'resolve', '--snapshot', path], keeper).error.code).toBe('court_usage');
    expect(bin(['kleros', 'juror', 'draw', '--snapshot', path], keeper).error.code).toBe('court_usage');
    expect(bin(['disputes', 'resolve', '--snapshot', path], { ...keeper, command: 'submit' }).error.code).toBe('court_input');
    expect(bin(['disputes', 'resolve', '--snapshot', path, '--submit'], keeper).error.code).toBe('court_usage');
  });

  it.each([[3, 4n, 'Accepted'], [4, 3n, 'Rejected'], [5, 2n, 'Voided']] as const)(
    'shows Agreement state %i and separate ruling %s consistently across native and recorded reads', (state, ruling, label) => {
      const fixture = caseFixture({ id: 0n, period: 4, finalised: true, state, ruling })
        .set(agreement, agreementAbi, 'getCurrentSettingId', [], 5n)
        .set(app, convictionVotingAbi, 'getProposal', [777n], [0n, false, juror, 0n, 0n, 0n, 11n, 0, juror, 0n]);
      for (const method of ['canChallenge', 'canClose', 'canSettle', 'canClaimSettlement', 'canDispute']) {
        fixture.set(agreement, agreementAbi, method, [11n], false);
      }
      writeFileSync(path, JSON.stringify(fixture.json()));
      const show = bin(['disputes', 'show', '11', '--chain', '31337'], {}, 'latest');
      expect(show.data.challenge).toMatchObject({ stateCode: state, state: label, ruling: String(ruling) });
      const status = bin(['disputes', 'status', '--proposal', '777', '--chain', '31337', '--adapter', adapter], {}, 'number');
      expect(status.data.action.latestChallenge).toMatchObject({ stateCode: state, state: label, agreementRuling: String(ruling) });
      expect(bin(['kleros', 'case', 'settlement', '--snapshot', path], keeper).data).toMatchObject({
        challengeState: label.toLowerCase(), appliedAgreementRuling: String(ruling) });
    }
  );

  it.each([
    [0n, false, 2, 'before-callback'], [1n, false, 2, 'before-callback'],
    [1n, true, 2, 'awaiting-agreement'], [1n, true, 4, 'agreement-resolved']
  ] as const)('separates round %s, callback %s and Agreement state %s', (roundId, finalised, state, stage) => {
    const recording = caseFixture({ id: 0n, roundId, period: finalised ? 4 : 2, finalised, state, ruling: finalised ? 3n : 0n });
    writeFileSync(path, JSON.stringify(recording.json()));
    const response = bin(['kleros', 'case', 'settlement', '--snapshot', path], { ...keeper, roundId: String(roundId) });
    expect(response.ok).toBe(true);
    expect(response.data).toMatchObject({ roundCount: String(roundId+1n), stage, coreRuling: finalised ? '1' : null,
      appliedAgreementRuling: state === 4 ? '3' : null });
  });

  it('keeps native Conviction and Decision reads on their existing paths', () => {
    const fixture = caseFixture().set(app, convictionVotingAbi, 'getProposal', [777n], [0n, false, juror, 0n, 0n, 0n, 11n, 0, juror, 0n])
      .set(app, disputableVotingAbi, 'getVote', [777n], [10n, 2n, 100n, 1000n, 99n, 0, 7n, 11n, 0n, 0n, 0n, 0, zeroHash])
      .set(app, disputableVotingAbi, 'getSetting', [7n], [86400n, 1n, 1n, 0n, 0n, 0n, 0n])
      .set(app, disputableVotingAbi, 'isVoteOpenForVoting', [777n], true)
      .set(app, disputableVotingAbi, 'canExecute', [777n], false);
    writeFileSync(path, JSON.stringify(fixture.json()));
    expect(bin(['proposals', 'show', '777', '--chain', '31337'], {}, 'latest').data).toMatchObject({ proposalId: '777', status: 'Active' });
    expect(bin(['decisions', 'show', '777', '--chain', '31337'], {}, 'latest').data).toMatchObject({ voteId: '777', actionId: '11' });
  });
});
