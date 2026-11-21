import { describe, expect, it } from 'vitest';
import type { ChainClient } from '../../src/onehive/clients/chain.js';
import { readJuryTiming } from '../../src/web/jury-timing.js';

const core = '0x1111111111111111111111111111111111111111' as const;
const kit = '0x2222222222222222222222222222222222222222' as const;
function view(period = 'vote') {
  return { core, kit, coreId: 5n, courtId: '1', timesPerPeriod: [8n, 9n, 10n, 11n] as const, drawn: true,
    jury: { period, kitActive: true, paused: false, roundId: '0', hiddenVotes: false, seats: [], canPreview: false } };
}
function client(phase: number, extra: Record<string, unknown> = {}) {
  const reads: Record<string, unknown> = { disputes: [1n, core, phase, false, 100n], arbitrationPauseGracePeriodEnd: 0n, ...extra };
  return { async readContract({functionName}: {functionName: string}) { if (!(functionName in reads)) throw Error(); return reads[functionName]; } } as ChainClient;
}
describe('candidate period transition context', () => {
  it('separates elapsed time from early completion, including equality', async () => {
    const v = view(), c = client(2, { areVotesAllCast: true });
    expect((await readJuryTiming(c, v, 109n)).transition).toContain('all required votes');
    expect((await readJuryTiming(c, v, 110n)).transition).toContain('time threshold reached');
    expect((await readJuryTiming(client(2), v, 109n)).transition).toContain('unavailable');
    expect((await readJuryTiming(client(2), v)).transition).toContain('unknown');
  });
  it('honors strict grace end and evidence draw gates, and waives time in appeal rounds', async () => {
    const c = client(0, { arbitrationPauseGracePeriodEnd: 101n }), v = view('evidence');
    v.jury.roundId = '1';
    expect(await readJuryTiming(c, v, 101n)).toMatchObject({ timeThreshold: '100', transition: 'Pause grace period still active.' });
    v.drawn = false;
    expect((await readJuryTiming(c, v, 200n)).transition).toContain('drawn');
  });
  it('reports complete choices separately from the early-close predicate; unknown stays unknown', async () => {
    const v = view('appeal');
    expect(await readJuryTiming(client(3, { isAppealFunded: true, getFundedChoices: [] }), v, 108n))
      .toMatchObject({ fundedChoices: [], transition: 'Eligible for transition: early appeal-close condition met.' });
    expect((await readJuryTiming(client(3), v, 200n)).fundedChoices).toBe(null);
    v.jury.kitActive = false;
    expect((await readJuryTiming(client(3, { getFundedChoices: [1n] }), v, 200n)).status).toBe('unavailable');
  });
});
