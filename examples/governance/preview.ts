import { core, fixture, kit, profile as base } from './fixture.js';
import { devNull } from 'node:os';
import { ONEHIVE } from '../../src/onehive/addresses.js';
import { listen, webServer } from '../../src/web/server.js';
import type { Profile } from '../../src/web/profile.js';

Object.assign(process.env, { DOTENV_CONFIG_PATH: devNull, ONEHIVE_AGREEMENT: ONEHIVE.AGREEMENT,
  ONEHIVE_CONVICTION_VOTING: ONEHIVE.CONVICTION_VOTING, ONEHIVE_DISPUTABLE_VOTING: ONEHIVE.DISPUTABLE_VOTING });
const { query } = await import('../../src/web/queries.js');
const appeal = process.env.HONEY_DEMO_APPEAL;
const profile: Profile = { ...base, ...(appeal ? { appealKit:kit } : {}), stake: { core, courtId: '1' } };
const deps = fixture({ ...(appeal ? { appeal: appeal === 'other-token' ? 'other-token' as const : 'known' as const } : {}), ...(process.env.HONEY_DEMO_ESCALATION === '1' ? { escalation: 'waiting' as const } : {}), partyEvidence: process.env.HONEY_DEMO_PARTY_EVIDENCE === '1', challenge: true, zeroAllowance: process.env.HONEY_DEMO_ZERO_ALLOWANCE === '1', stakePhase: process.env.HONEY_DEMO_DRAWING === '1' ? 2 : 0 });
const server = webServer(profile, q => query(profile, q, deps), 'fixture');
console.log('Honey · synthetic fixture · ' + await listen(server, 0));
