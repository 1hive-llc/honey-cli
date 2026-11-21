# Local Honey governance explorer

Start the explorer from the standalone CLI checkout with Node 22 and the lockfile dependencies installed. The startup profile is a local dotenv file that you select. The printed URL opens the browser interface.

```sh
npm ci
node bin/honey-web.mjs --profile /absolute/path/to/honey-read.env --port 8787
```

Open `http://127.0.0.1:8787/`. Pass `--port 0` to have the operating system select a free port. Stop the server with Ctrl-C. Profile changes take effect after restarting. Starting the process reads the profile locally. Opening lists, details and simulations issues the relevant reads.

## Select the sources

- Set `HONEY_WEB_CHAIN_ID` to `100` (default, Gnosis), `10200` (Chiado) or `31337` (local fork). Supply the matching `GNOSIS_RPC_URL`, `CHIADO_RPC_URL` or `FORK_RPC_URL` explicitly. Remote endpoints use HTTPS. Loopback endpoints can use HTTP.
- For indexed lists, use the CLI's `GARDENS_SUBGRAPH_URL` or the matching network-specific Gardens URL. The Gnosis profile also accepts `THE_GRAPH_API_KEY` with the CLI's Gardens deployment. Chiado requires an explicit URL or a key and a deployment ID. For a fork, supply its own index URL or use known IDs.
- For RPC-only lists, supply comma-separated decimal app IDs in `HONEY_WEB_PROPOSALS` and/or `HONEY_WEB_VOTES` (up to 256 of each). These lists take precedence over indexed discovery. With neither an index nor a list, open a proposal or vote directly by ID.
- For case discovery, set `HONEY_WEB_ADAPTER` to the reviewed Kleros Agreement adapter address on the selected chain. The CLI's `ONEHIVE_DAO_KERNEL`, `ONEHIVE_CONVICTION_VOTING`, `ONEHIVE_DISPUTABLE_VOTING` and `ONEHIVE_AGREEMENT` keys select the indexed DAO and deployed contracts. Check these against the deployment, particularly on Chiado or a fork. Seed defaults refer to 1Hive on Gnosis.

For example, this profile selects direct reads from a locally running Gnosis fork. Populate the optional fields with IDs and an adapter from your own deployment.

```dotenv
HONEY_WEB_CHAIN_ID=31337
FORK_RPC_URL=http://127.0.0.1:8545
HONEY_WEB_PROPOSALS=
HONEY_WEB_VOTES=
HONEY_WEB_ADAPTER=
```

## Interpret a page

**Conviction proposals and Decision votes.** The Gardens reader scopes the list to the DAO and app types, newest first, eight records per page. The indexed-state selector filters the index before pagination. Text search filters the visible page. The query requests the index block and indexing-error flag alongside the records. Missing block metadata appears as unavailable. Indexed status, title and number come from the selected index. The index chain is operator-configured. Its block can differ from the RPC block, and the index can advance between pages.

**Record details.** Opening a record uses the Honey CLI's Conviction or Decision reader. The server checks the RPC chain, obtains a block, and pins all app, Agreement, adapter and Core getters in that query to that block. A fresh detail query can see a later block than a previous list. Token and voting amounts retain the contract's integer precision.

**Kleros cases.** Each page checks the latest linked Agreement challenge for its candidate proposal and vote IDs. The action must point back to the app and local ID, its saved setting must identify the configured adapter, and the adapter and Core dispute links must agree. An active case requires an active disputed challenge, an open Agreement action and unruled Core/adapter records. A final adapter ruling waiting for Agreement resolution appears separately. Legacy Celeste, completed and unchallenged records can be inspected in their app details. Inconsistent or unavailable links appear as unknown. Case counts cover only that page and those latest challenges. There is no global or historical court census.

A completed page can contain zero active cases. Partial observations show an unknown count or an index warning. Missing configuration and failed reads have separate states. A whole-query timeout produces an unavailable result. Select **Active, awaiting and unknown** to inspect individual observations, and **Next** to inspect more candidates.

**Previews and terminal steps.** On the Conviction tab, **Preview a proposal** calls Honey's existing unsigned `addProposal` builder with explicit public actor and beneficiary addresses, title, link, decimal amount and stable-request flag. The RPC receives these fields as simulation calldata. The result shows method, addresses, gas estimate and builder checks. This simulation uses latest RPC state and does not report a pinned simulation block. A successful simulation is evidence about that call at query time. The browser has no method to sign or submit it.

Record details include copyable commands for app state, Agreement/court status, and applicable challenge or app execution previews. Set `HONEY_PROFILE` to the same local profile before using a template. The templates require explicit values for their public actor, evidence or reviewed execution script where applicable. They run only when the operator executes them in a terminal. A challenge can lock collateral and incur arbitration costs. The seed supports court inspection. An Agreement.resolve builder belongs to a separate optional patch. Core ruling finalization and Agreement resolution are distinct from app execution.

## Local boundary

Only `127.0.0.1` is bound. The HTTP handler checks Host, browser Origin, fetch-site context and a same-origin request header. Fixed routes serve static assets, typed list/detail, jury and stake queries, and structured JSON proposal, ballot and stake simulations. It rejects arbitrary commands, endpoints, paths and flags. Each production query runs in a short-lived worker with only the read configuration. RPC methods are restricted to chain, block, contract call, code, log reads and gas estimation. Operators' endpoints, paths, credentials, raw exception text, wallet settings and submit-ready payloads stay out of browser responses.

Requests cap at two concurrent queries and 20 seconds, with a 4 KiB simulation body, fixed page sizes and a 1 MiB upstream response limit per read. Responses use a restrictive CSP, no-store and no CORS. The UI uses no browser storage, external assets or wallet connector.

## Reproduce the fixture check

```sh
bash examples/governance/demo.sh jury
# Open the printed 127.0.0.1 URL. Stop with Ctrl-C.
./node_modules/.bin/vitest run test/web/web.test.ts
RUN_FORK_E2E=0 npm run check
```

The separate preview entry point uses synthetic, in-memory contract and index responses. The UI marks it **Synthetic fixture**. The contract test compares proposal 21 and its linked case with the actual `honey proposals show` and `honey disputes status` dispatchers on synthetic chain 31337 at RPC block 7654321. It pins the CLI proposal reader's injected client for this comparison. The fixture index reports block 7654312. On-chain proposal state is Paused, Agreement action 121 has challenge 7, and Core dispute 0 is in the vote period in court 5. The next candidate page has two checked records and zero active cases. The fixture evidence covers neither live endpoints nor current deployments.

## Browser pilot: My Jury

Open a linked Kleros case from **Kleros cases**, or from the related Conviction proposal or Decision vote. Under **My Jury**, enter the juror’s public address to see that wallet’s seats in the current round and the case’s party evidence references. Multiple draw seats per wallet are displayed individually, including whether each was voted. References are displayed as text; Honey does not open them, retrieve a document, or send a notification.

For evidence, set `HONEY_WEB_ADAPTER_FROM_BLOCK` to the adapter deployment height (not the Core deployment or the case’s latest block). The pilot reads the Honey adapter’s `EvidenceSubmitted` events, not the upstream Kleros EvidenceModule. It scans the configured interval in 2,000-block chunks, with a total of up to 10,000 blocks and 100 evidence records per case. If this range or the RPC is unavailable, the UI discloses that rather than reporting zero evidence. Longer histories need an index. Number-pinned observations can still be affected by chain reorganizations.

For a local loopback fork with chain ID 31337 and a compatible public-ballot kit, **Simulate public ballot** opens only for an active, unpaused vote with owned and unvoted seats. Choose the exact seats, a ruling and optional public justification. On submit the server re-reads the round and bindings and runs a pinned `eth_call` from the selected account. This does not connect a wallet, expose signing calldata, send a transaction, or advance the fork. On Gnosis and Chiado this ballot path is read-only.

For a self-contained walkthrough using synthetic state (no RPC required):

```sh
bash examples/governance/demo.sh jury
```

Open the printed local URL, select **Kleros cases**, open Conviction proposal **#21**, then choose **Try the demo juror**. Expand **Party evidence references** and simulate a ballot on unvoted seat **0**. Seat **2** is shown as already voted. The fixture only simulates request handling and does not execute real EVM bytecode.

`npm run check` covers the HTTP guards, typed fixture reads, stale/foreign/already-voted seats, simulation arguments, and selected real Decision case receipts projected into a read-only transport. Optional actual-browser smoke test with an existing Playwright install (and its installed Chromium): `PLAYWRIGHT_LOCAL=/absolute/path/to/playwright node test/web/browser-smoke.cjs`. No Playwright dependency was added to the CLI.

## Browser pilot: My stake

Open **My stake** and enter a public wallet address. The panel separates that wallet's current stake in the selected court, HNY locked across courts, HNY balance, Core allowance and the court minimum. The eligibility indicator checks this court's roster gate and any required juror NFT. The stake planner separately checks identity compatibility, stake limits and allowance for an increase. The wallet is not connected.

To enable the panel, set `HONEY_WEB_STAKE_CORE` and `HONEY_WEB_STAKE_COURT_ID` for the reviewed human court and also set `HONEY_WEB_ADAPTER`. The server checks the configured adapter, Core, HNY and sortition links at a single canonical block. It requires the court's eligibility gate and a nonzero minimum. The selected RPC must support canonical hash reads (EIP-1898).

On a loopback chain 31337 profile, the input is an **absolute stake target** in HNY, not a deposit amount. The preview checks the block against the displayed snapshot, runs Honey CLI's stake planner, and simulates its exact call from the specified address. It can report that the request would apply immediately or enter the delayed queue. Entering the queue does not apply stake or move HNY at that point. A reduction or exit is not a promise of immediate payment; locks can remain. Capacity, phase and eligibility can change after the preview. Gnosis and Chiado profiles can read the selected court but cannot simulate a stake change here.

This panel never signs, submits, changes allowance or executes queue entries. No mainnet actions are performed in the demo. For exact RPC coverage, see `test/web/stake.test.ts`.

For a synthetic walkthrough, run the fixture as above, then choose **My stake → Try the demo wallet**. The demo starts at 50 HNY staked with 12 HNY locked. Enter `60` to preview an increase. Run the fixture with `HONEY_DEMO_DRAWING=1` to see the delayed path; enter `0` to preview a queued exit. Neither demo changes state.

## Browser pilot: My Jury inbox

Choose **My Jury inbox**, enter a public wallet address, and check assignments. The lookup scans one ordinary governance candidate page at a time. It checks the candidate's current Agreement challenge and verifies the linked Core round, Classic kit and individual vote seats. It does not search historical rounds, disconnected governance apps or the entire Kleros court. **Next** checks a different candidate page, even when the current one is empty. A partial page is not evidence that nobody was assigned.

An outstanding public ballot in an active, unpaused voting round shows **Vote needed**. That is an on-chain phase observation, not a deadline or permission to sign. Cases can also show that voting is complete, an appeal phase is active, the case is waiting, or the action is unsupported. Opening an assignment carries the entered address into the case and reads the evidence references and seats. The browser neither downloads external evidence nor asks the wallet to sign.

Case details distinguish a time-based threshold from actual readiness to advance. Some periods can end earlier if the contract's completion condition is met, and becoming eligible does not move the case until someone advances it. In the appeal phase, fully funded choices are shown only when read from the bound Classic kit. This display does not quote costs, confirm either side can still fund, or submit an appeal.

In the synthetic fixture, choose **My Jury inbox → Try the demo wallet**. The seeded Conviction case has one outstanding seat and one voted seat. Open the assignment, expand either party’s sample under **Party evidence references**, then return to the ballot preview. The text is fictional and bundled only for the demo. The browser never opens the listed reference; if a sample is not bundled, the submitting address and original reference are still shown.

## Browser pilot: Decision ballot, token allowance, and settlement

**Decision ballots.** Open a normal, open Decision vote on a loopback chain 31337 profile and choose **Simulate Decision ballot** with an explicit public voter address and Yea or Nay. This is the governance ballot, not a Kleros juror ballot. The existing Honey CLI builder checks voter eligibility and simulates against the local RPC. The return is an unsigned result, not a saved vote or a submit-ready transaction. Paused or closed votes are not offered.

**Stake allowance.** In **My stake**, token approval is a separate simulation from setting stake. For an eligible increase with zero allowance, enter the full target stake; the approval preview covers exactly the target minus current court stake to the configured Core. If an existing positive allowance is insufficient, the replacement is not offered by the planner: preview clearing it separately. Neither simulation changes the token allowance. An approved token spend, a stake change, and release of locked tokens are three distinct events.

**Settlement.** Open a linked Kleros case and choose **Load settlement receipt**. The same-block read distinguishes a pending Core callback, a delivered ruling awaiting Agreement resolution, and a recorded Agreement resolution. Recorded collateral and fees are shown in token base units; they are not a payout receipt. The view does not infer the underlying proposal executed or any money moved.

## Browser pilot: challenge quote and simulation

On a loopback chain 31337 profile with the Honey Kleros adapter configured, open an eligible unchallenged Conviction proposal or Decision vote and find the **Agreement challenge** section. Load a quote for the prospective challenger's public address. The app derives the Agreement action and its saved court setting from the selected record; the actor cannot supply a raw action ID, arbitrator, fee token or contract target.

The quote separates **challenger collateral** from the **arbitrator fee**. The sum is the HNY the challenger would need to escrow with Agreement; it excludes network gas. The settlement offer is separate: it proposes taking an amount from the submitter's already locked collateral, and does not increase the challenger's escrow. A quote can be unavailable or ineligible. Insufficient balance, allowance to Agreement, or challenge permission blocks simulation; no approval action is provided here.

The browser rechecks the quoted block and simulates only the bound Agreement call, with a public context reference and no early evidence close flag. It doesn't sign, submit, retrieve the reference, lock any tokens or change the chain. This slice does not implement later evidence submissions, dispute escalation or rechallenge controls.

## Browser pilot: additional party evidence

For a linked current dispute on a loopback fork, check a public address as the submitter or challenger, then simulate adding a public evidence reference. The browser accepts a short public label or a bare IPFS CID URI, not an upload, URL with credentials or query parameters, or private text. The configured local RPC receives the reference for simulation. The browser never opens the URI, checks a gateway, signs a transaction or submits evidence.

A recorded reference is not proof that its file is available or that jurors reviewed it. The evidence view reports the recording block where available, without attributing it to an earlier round. Parties can add evidence during appeal before the adapter finalizes, but that does not extend voting or guarantee review. This pilot does not mark evidence finished or offer early closure.

## Browser pilot: taking a challenge to court

For a Waiting challenge bound to the configured Honey Kleros adapter, **Escalate to arbitration** checks the submitter's public address and reads the current response deadline. The original submitter must still be able to dispute before that deadline. The quote separates the submitter's current arbitration fee from the arbitration fee the challenger already escrowed; they can differ. The challenger’s previously locked collateral is not a new charge to the submitter. Network gas is not included.

The loopback-only simulation binds to the quoted block, derives the Agreement action from the selected Conviction proposal or Decision vote, and rechecks the saved court, role, deadline, fee, HNY balance and allowance. It does not collect either fee, create a case or request early evidence close. Taken together with the challenge and party-evidence previews, this is still a rehearsal, not a signing workflow.

## Browser pilot: read-only Appeal window

Open an active linked case in Appeal and choose **Load appeal window**. It shows the current round, preliminary court ruling, the window returned by Core, block time, pause state, and which choices are fully funded. The preliminary ruling is not the final outcome. A choice that is not fully funded may still have partial contributions.

To show HNY quotes and side-specific cutoffs, the startup profile can pin the reviewed deployed Honey Classic kit with `HONEY_WEB_APPEAL_KIT`; it must match the kit registered for the case. A verified base appeal cost is separate from each choice's gross funding target. Neither is a remaining balance or an individual contribution quote. The cutoffs are exclusive and observations are anchored to the displayed block, not wall-clock promises. If the kit, asset, or cost cannot be verified, the browser does not assume a denomination or invent targets. The view cannot fund an appeal or claim a withdrawal.

## Proposal workspace styling

The browser uses Bootstrap 5.3.8's distributed CSS for buttons and form controls, plus selected Lucide 0.553.0 icons embedded in the HTML. The pinned assets and their upstream licenses are under `src/web/assets`. They are local assets, with no CDN, JavaScript framework or new runtime dependency. Desktop opens records next to the list; smaller screens use the existing modal workflow. The case timeline summarizes the verified bindings and current phase, not an event history.
