# Honey v1 governance and Kleros court review

Use the existing `honey proposals` commands for Conviction Voting and `honey decisions` for Decision Voting. Their builders and the original `honey kleros stake --amount HNY` interface keep their seed contracts. The new `kleros juror stake` uses an explicit target in raw units and replays a block recording.

`honey disputes status [--proposal ID | --vote ID] [--agreement ADDRESS] [--adapter ADDRESS] [--chain ID] --json` reads the current setting and, for a selected app record, its saved setting and latest challenge at one block height. The action may belong to an older court. Known Gnosis Celeste and unrecognized settings receive no court-specific reads. Reorganizations can affect height-pinned status. Native Agreement and governance commands use the existing RPC configuration.

The grouped commands below prepare a public-vote Classic case from Honey staking through Agreement settlement. Twelve produce an unsigned preview and two return data. Replay requires one supplied block recording and no RPC connection. The candidate reference is honey-v2 `abac54929aed544a95f7a5734628a1d7e672fd65` and the CLI seed is `ad075f63424261b69380138335aa8be20995d9ab`.

## Run it

From a checkout with the lockfile dependencies installed, use the same executable for each group.

```sh
./bin/honey.mjs kleros juror --help
./bin/honey.mjs kleros keeper draw --snapshot block.json --json < draw.json
./bin/honey.mjs disputes resolve --snapshot block.json --json < case.json
```

To inspect a synthetic juror's two seats, run this complete offline example.

```sh
court_example="$(mktemp -d)"
node --import tsx --input-type=module - "$court_example" <<'JS'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { caseFixture, caseRequest } from './test/kleros-court/fixture.ts';
const path = process.argv[2];
writeFileSync(join(path, 'block.json'), JSON.stringify(caseFixture().json()));
writeFileSync(join(path, 'juror.json'), JSON.stringify(caseRequest));
JS
./bin/honey.mjs kleros juror my-votes --snapshot "$court_example/block.json" --json < "$court_example/juror.json"
```

The example reports vote IDs `"0"` and `"2"` for the requesting wallet. A person preparing a public vote supplies the precise seat IDs, one choice and a public justification. A keeper can perform the global and dispute maintenance steps with a separate wallet.

Every request supplies `chainId` (JSON number 100, 10200 or 31337), `core`, `honey`, and `from` (explicit addresses). Dispute commands also require `agreement`, `adapter`, `classic`, `challengeId`, and the expected current `roundId`. Supply all IDs, amounts and iteration counts as unsigned decimal **strings**. `targetRaw` uses the 18-decimal Honey token's smallest unit. The command name is a CLI argument.

| Command | Additional fields | Caller and contract behavior |
| --- | --- | --- |
| `kleros juror approve-stake` | `courtId`, `targetRaw` | Juror → Honey `approve(Core, delta)`. Computes the increase over the existing court stake. Requires sufficient balance, an eligible wallet, room under the caps and zero existing allowance. |
| `kleros juror clear-stake-allowance` | — | Juror → Honey `approve(Core, 0)`. A separate reviewable step for clearing a positive allowance. |
| `kleros juror stake` | `courtId`, `targetRaw` | Juror → Core `setStake`. The amount is the total target. Zero requests exit. Requires the configured NFT when present. Increasing checks court eligibility, minimum, caps, path count, identity binding on weighted ancestors, wallet balance and Core allowance. |
| `kleros keeper pass-phase` | `phase` = `staking`, `generating` or `drawing` | Keeper → SortitionModule `passPhase()`. Staking needs a pending draw and elapsed minimum time. Generating depends on a nonzero RNG response. Drawing ends when all draws finish or the timeout elapses. |
| `kleros keeper draw` | `iterations` | Keeper → Core `draw(coreId, iterations)` in evidence and drawing phase. Rejected draws can leave seats empty. Each successful draw locks the round's raw stake amount. |
| `kleros keeper pass-period` | `period` = `evidence`, `vote` or `appeal` | Keeper → Core `passPeriod(coreId)`. Evidence requires all seats and initial-round evidence time. Voting can finish early when all seats voted. The appeal interval can finish early when Classic's `isAppealFunded` condition holds. Core checks arbitration pause and grace time. |
| `kleros juror my-votes` | — | Reads Core's current round and Classic's `getVoteInfo(coreId, roundId, seat)`. Returns each seat assigned to `from`, its voted flag, and the Agreement action/challenge context and setting ID. Further evidence can appear in the adapter's `EvidenceSubmitted` events. |
| `kleros juror vote` | `voteIds` (nonempty array of decimal strings), `choice` = `refuse`, `challenger` or `submitter`, `justification` (public string) | Drawn juror → active Classic `castVote(coreId, voteIds, choice, 0, justification)`. Requires an open, unpaused public voting period and uncast, caller-owned seats. Checks the **round's** court-parameter revision. |
| `kleros keeper execute-rewards` | `iterations` | Keeper → Core `execute(coreId, roundId, iterations)` during execution with asset operations unpaused. Redistributes penalties and fees in bounded work. Remaining iterations depend on coherent count. |
| `kleros keeper execute-ruling` | — | Keeper → Core `executeRuling(coreId)` once in execution with arbitration unpaused. Core obtains its final choice and calls the adapter. Reward processing can proceed independently. |
| `disputes resolve` | — | Operator → Agreement `resolve(agreementDisputeId)` after callback delivery while the challenge remains disputed. Agreement pulls the ruling, settles the challenge economics and calls the disputable application. |
| `kleros case settlement` | — | Reads Agreement challenge state, recorded fee/collateral amounts, action closure, adapter finality and the applied Agreement ruling. The additive roundCount and stage fields distinguish a later round, delivery to the adapter, and application by Agreement. Recorded amounts are not payout evidence. |
| `kleros keeper execute-delayed-stakes` | `iterations` | Keeper → SortitionModule `executeDelayedStakes` in staking phase with a nonempty queue and unpaused assets. A queued change can fail during processing. Inspect its outcome before assuming the target took effect. |
| `kleros juror withdraw-leftover` | `beneficiary` | Any caller → SortitionModule `withdrawLeftoverPNK(beneficiary)`. Released Honey goes to the fully exited beneficiary after locks clear. Requires positive leftover and unpaused asset transfers. |

All transaction previews carry zero native value. Increases outside the staking phase can be queued before Core transfers Honey. The CLI checks current funding and eligibility for those increases, and actual application uses the state at processing time. A lower target can leave locked Honey in Core. If a weight strategy is unconfigured the increase preview fails. Verified identity weighting changes selection probability, while wallet balances, stake exposure, and penalties use raw Honey.

## Trace the challenge

The Agreement path starts with an action registered under a specific Agreement setting, a challenge and a dispute raised by the submitter. The contract integration fixture sets the application challenge role, signs the setting, funds and authorizes collateral through Aragon Staking, and supplies Agreement's Honey fee allowances. The immutable Agreement alone calls the adapter's two-choice `createDispute`. The adapter pulls the quoted submitter fee and approves Core for that fee. Agreement holds the separate challenger escrow. Core must accept the Honey fee token, have a valid rate and court/kit configuration, and admit the adapter when its arbitrable whitelist is enabled. The dispute commands start from that existing disputed challenge.

| Identifier | Source and use |
| --- | --- |
| Agreement challenge and action | `Agreement.getChallenge(challengeId)` provides the action, challenge state and adapter dispute ID. `getAction(actionId)` identifies the disputable application, its local action ID, setting and active challenge. |
| Agreement dispute | `uint256(keccak256(abi.encode(adapter, coreId)))`. The runner checks the adapter's forward and reverse mappings and Core's arbitrated address. This full-width ID is the argument to `Agreement.resolve`. |
| Core dispute and round | The Core ID may be zero. The current round is `Core.getNumberOfRounds(coreId) - 1`. Core's round records fee token, kit ID, drawn jurors and court-parameter revision. The Classic kit at slot 1 must link back to Core and report this dispute and round active. |
| Vote seat | Zero-based position in the Core round's drawn-juror array. A wallet may hold multiple seats. Classic checks each vote's owner and cast flag using Core IDs, and translates to kit-local IDs internally. |
| Final ruling | Core 0/1/2 maps to Agreement 2/3/4 (void/reject/accept). Only Core delivers the callback, and only Agreement pulls it. An accepted or voided action can still require a separate close to release collateral. Proposal execution is a separate application operation. |

Source anchors within the pinned honey-v2 tree are KlerosCore (external checkout: `honey-v2/vendor/kleros-v2/contracts/src/arbitration/KlerosCore.sol`), SortitionModule (external checkout: `honey-v2/vendor/kleros-v2/contracts/src/arbitration/SortitionModule.sol`), DisputeKitClassic (external checkout: `honey-v2/vendor/kleros-v2/contracts/src/arbitration/dispute-kits/DisputeKitClassic.sol`), KlerosAgreementAdapter (external checkout: `honey-v2/src/optimistic/KlerosAgreementAdapter.sol`), and AgreementIntegration.t.sol (external checkout: `honey-v2/test/AgreementIntegration.t.sol`). Those links assume sibling repository checkouts.

## Recording and integration

A recording contains ABI-encoded calldata and return bytes for public getters at **one** block. A collector must provide chain, block hash, number, timestamp, and all results from that same block. Provenance is caller-supplied. A recording is reproducible input, and carries no independent proof of deployed code, freshness or authorization.

```ts
type Recording = {
  chainId: 100 | 10200 | 31337;
  blockNumber: string;
  blockHash: string;
  timestamp: string; // Unix seconds
  calls: Array<{ to: string; data: string; result: string }>;
};
```

The command accepts a subset of reads for its specific path. Start with an empty `calls` array to discover a missing read. Error code `court_missing_read` includes `{to, data, method, blockHash}` in `error.details`. Supply the getter's public ABI return bytes from the indicated block and retry. Duplicate target/calldata pairs, malformed return encodings, mismatched bindings and wrong chains fail closed. All output uses the package's `ok/data/warnings` or `ok/error` envelope with a 0/nonzero process exit.

With an independently authorized read-only endpoint, the optional collector can generate the recording. It uses the existing RPC URL convention for the requested chain. Choose an explicit decimal height. Capture checks the chain and header and fetches only getters requested by the selected operation. Every `eth_call` specifies the block hash and `requireCanonical: true`. Missing hash-read support, an invalid result, a failed precondition or more than 256 getters fails capture. The output envelope can be replayed directly. Mock transport coverage is offline.

```sh
./bin/honey.mjs kleros capture resolve --block HEIGHT --json < case.json > block.json
./bin/honey.mjs disputes resolve --snapshot block.json --json < case.json
```

**Resolve input.** Supply `chainId`, `core`, `honey`, `from`, `agreement`, `adapter`, `classic`, `challengeId` and `roundId` as described above. Resolve requires an open action with its active challenge, the arbitrator in that action’s saved setting, matching adapter/Agreement/Core/token and Classic round bindings, a delivered Core ruling matching the finalized adapter ruling, and Honey-denominated fees and collateral. The calldata targets Agreement with the full namespaced dispute ID. The optional action-ID builder uses read and simulation callbacks. It is retained under tests as an independent comparison. Identical synthetic state produces identical transaction bytes for each ruling. Only the recording builder ships as a command.

**State labels.** In the pinned Agreement fixture, state 3 emits ActionAccepted, state 4 emits ActionRejected and state 5 emits ActionVoided. Their adapter rulings are respectively 4, 3 and 2. This corrects the old `disputes show` text for 3/4. Numeric fields and the envelope are stable. Old court recordings that omit `getSetting(action.settingId)` need its public return bytes at the original block (and `currentRuling` for finalized settlement/resolve). Case replay reports the missing getter.

The unsigned `data.preview` carries chain, sender, target, zero value, ABI calldata, decoded arguments, `simulation.status = "not-run"`, and failing simulation/deployment policy checks. Its inherited confirmation text is display metadata. Use fresh observations when preparing later steps. The calldata for `passPhase`, `passPeriod`, `draw` and `castVote` omits the caller's expected phase, period or round, so an old preview can acquire different effects. RNG availability in the generating phase remains conditional until the contract receives its random number.

## Verification and limits

```sh
npm run typecheck
./node_modules/.bin/vitest run test/kleros-court test/onehive/kleros.test.ts
```

The focused tests use synthetic public block recordings, check exact calldata and role separation, exercise Core ID zero and IDs above JavaScript's safe integer range, and cover each final Agreement outcome. They execute the Honey CLI as a child process as well as its library entrypoint.

An optional independent ABI check accepts `.abi` files generated by Solidity 0.8.30 from the pinned candidate using the locked OpenZeppelin contracts 5.5.0. Compile Core, SortitionModule, DisputeKitClassic, HoneyStakeWeightStrategy and KlerosAgreementAdapter with `solc --abi --via-ir --optimize`, using the honey-v2 root as base path and the dependency directory containing `@openzeppelin` as include path. Then run the following from honey-cli.

```sh
node --import tsx test/kleros-court/check-abis.ts /path/to/compiled-abis
node --import tsx test/kleros-court/check-agreement.ts /path/to/legacy-agreement/artifacts
```

The checks cover 52 candidate getter and operation signatures, return layouts and mutabilities. Legacy Agreement getters come from the CLI's existing Agreement ABI. The separate `resolve(uint256)` binding follows the pinned integration fixture. Mock tests establish encoding and preconditions. EVM execution, legacy bytecode settlement, production implementation/ACL verification, and application-specific callback effects require separate evidence.

Unsupported commands include hidden-vote commit/reveal, appeal contributions and reimbursements, historical-round reward execution, evidence indexing, production initialization, privileged configuration and proposal execution. The appeal **period transition** remains part of an ordinary unappealed dispute. The runner contains no signer, submission path, automatic vote selection, or network transport.
