import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeFunctionData, zeroAddress } from 'viem';
import { describe, expect, it } from 'vitest';
import { coreAbi } from '../../src/kleros-court/abis.js';
import { runCourtCommand } from '../../src/kleros-court/run.js';
import { base, caseFixture, caseRequest, core, stakingFixture } from './fixture.js';

describe('offline command boundary', () => {
  const request = { command: 'my-votes', ...caseRequest };
  it('returns exact calldata for missing public reads and rejects corrupt, ambiguous, or wrong-chain recordings', () => {
    const snap = caseFixture().json();
    const empty = runCourtCommand(request, { ...snap, calls: [] });
    expect(empty.error).toMatchObject({ code: 'court_missing_read', details: {
      to: core, method: 'pinakion', data: encodeFunctionData({ abi: coreAbi, functionName: 'pinakion' }), blockHash: snap.blockHash
    } });
    const [first, ...rest] = snap.calls;
    if (!first) throw new Error('Missing fixture data.');
    expect(runCourtCommand(request, { ...snap, calls: [first, ...snap.calls] }).error?.message).toMatch(/Duplicate/);
    for (const result of ['0x01', first.result + '00'.repeat(32)]) {
      expect(runCourtCommand(request, { ...snap, calls: [{ ...first, result }, ...rest] }).error?.message).toMatch(/Invalid return/);
    }
    expect(runCourtCommand(request, { ...snap, chainId: 100 }).error?.message).toMatch(/chain/);
    expect(runCourtCommand(request, { ...snap, blockHash: 'latest' }).ok).toBe(false);
    expect(runCourtCommand(request, { ...snap, endpoint: 'unused' }).ok).toBe(false);
  });

  it('rejects unsupported operations, future secret fields, malformed addresses and lossy numeric input', () => {
    const f = caseFixture();
    for (const command of ['commit', 'reveal', 'fund-appeal', 'initialize', 'submit']) {
      expect(f.run(command, caseRequest).error?.code).toBe('court_input');
    }
    const vote = { ...caseRequest, voteIds: ['0'], choice: 'refuse', justification: '' };
    for (const invalid of [
      { salt: 'unused-field' }, { signature: 'unused-field' }, { from: zeroAddress }, { classic: '0x12' },
      { challengeId: 123 }, { roundId: '1.0' }, { challengeId: (2n ** 256n).toString() },
      { voteIds: ['-1'] }, { choice: 'auto' }, { justification: 'api_key=unused-test-token-123' }
    ]) {
      const res = f.run('vote', { ...vote, ...invalid });
      expect(res.error?.code).toBe('court_input');
      expect(JSON.stringify(res)).not.toMatch(/unused-/);
    }
    for (const invalid of [0, '-1', (2n ** 96n).toString()]) {
      expect(stakingFixture().run('stake', { ...base, courtId: invalid, targetRaw: '1' }).ok).toBe(false);
    }
    expect(f.run('draw', { ...caseRequest, iterations: '0' }).ok).toBe(false);
  });

  it('runs the isolated CLI with deterministic JSON and nonzero exit on failure', () => {
    const dir = mkdtempSync(join(tmpdir(), 'court-preview-test-'));
    try {
      const path = join(dir, 'snapshot.json');
      writeFileSync(path, JSON.stringify(caseFixture().json()));
      const run = (command: string, fields: unknown) => spawnSync(process.execPath,
        ['bin/honey.mjs', 'kleros', 'juror', command, '--snapshot', path, '--json'],
        { encoding: 'utf8', input: JSON.stringify(fields) });
      const success = run('my-votes', caseRequest);
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout)).toEqual(caseFixture().run('my-votes', caseRequest));
      const invalid = run('vote', { ...caseRequest, signature: 'unused-private-input' });
      expect(invalid.status).toBe(1);
      expect(JSON.parse(invalid.stdout).ok).toBe(false);
      expect(invalid.stdout + invalid.stderr).not.toContain('unused-private-input');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
