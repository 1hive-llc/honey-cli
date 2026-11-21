# Tool reference

This document summarizes the active `onehive_*` tool surface exposed through the standalone registry in `src/onehive/tool-registry.ts` and the `honey tool <name> ...` raw CLI dispatch.

For exact runtime schemas, inspect each tool definition in `src/onehive/tools/*.ts`. All handlers return a structured `OneHiveToolResult<T>`:

```ts
type OneHiveToolResult<T> =
  | { ok: true; data: T; warnings?: string[]; warningDetails?: WarningDetail[] }
  | { ok: false; error: { code: string; message: string; retryable?: boolean; details?: unknown } };
```

Write-capable tools return unsigned `TxPreview` objects unless the tool name explicitly includes `submit` or `approveAndSubmit`.

## Result conventions

Successful read tools usually return typed summaries plus optional warnings. Successful builder tools return a `TxPreview` containing at least:

- `chainId`, `from`, `to`, `value`, `data`;
- decoded method/arguments where safe to display;
- simulation result and gas estimate when required;
- policy checks and warnings;
- exact confirmation phrase for any later submit path.

Submission tools return handoff or submission metadata depending on signer mode:

- Safe: manual Safe transaction-builder payload/URL metadata.
- Keystore / signer daemon / external signer: submitted/rejected/ambiguous/error metadata from the signing path.
- Local fork dev key: fork-only submitted tx metadata.

## Common failure modes

Across tools, common failure codes include validation errors, wrong chain, missing bytecode, unknown or non-allowlisted target, ABI/selector mismatch, failed simulation, stale quote, insufficient allowance, unsafe approval, confirmation mismatch, missing keystore policy, signer rejection, and unavailable subgraph/RPC services.

Failures are intentionally fail-closed for write paths. A failure result means callers must not infer that a transaction is safe to submit.

## Context and Gardens reads

| Tool | Purpose | Key inputs | Output | Typical failures / warnings |
| --- | --- | --- | --- | --- |
| `onehive_context_resolve` | Resolve chain, known addresses, token metadata, balances, and optional bytecode verification. | `chainId`, `verifyCode`, `includeBalancesFor` | Chain/address/token context, feature flags, optional balances and bytecode rows. | Wrong active chain, RPC/token metadata failures, stale/unverified-code warnings. |
| `onehive_garden_list` | List Gardens v1 summaries. | `network`, `first`, `skip`, `orderBy` | Capped Garden summaries. | Subgraph/connect failures, page-size cap warnings. |
| `onehive_garden_proposals` | Fetch proposals for a Garden DAO. | `dao`, `network`, paging, status/type filters | Capped proposal summaries. | Unknown filters, subgraph failures, truncation warnings. |
| `onehive_garden_user` | Lookup a Gardens user. | `address`, `network` | User summary. | Subgraph failures or absent user data. |
| `onehive_honey_proposals_list` | Honey-scoped proposal list from Gardens subgraph with optional RPC cross-check. | `chainId`/`network`, `dao`, `limit`/`first`, filters, `crossCheckRpc` | Canonical Honey proposal summaries plus cross-check status. | Subgraph failure, RPC cross-check mismatch/failure, page cap warnings. |

## Governance and Decision tools

| Tool | Purpose | Key inputs | Output | Typical failures / warnings |
| --- | --- | --- | --- | --- |
| `onehive_honey_proposal_forecast` | Forecast whether a Honey Conviction proposal will pass with current support. | `proposalId`, optional `chainId`, `dao`, `averageBlockTimeSeconds` | Projected current conviction, threshold progress, eventual conviction, and estimated pass time. | Missing Gardens conviction config/subgraph endpoint, unknown proposal, RPC failure. |
| `onehive_governance_getProposal` | Read a Conviction Voting proposal by ID. | `proposalId`, `chainId` | RPC proposal state, amounts, beneficiary, submitter, status flags. | Unknown proposal, RPC failure, wrong chain. |
| `onehive_governance_addProposalTx` | Build `addProposal` preview. | `title`, `link`, `requestedAmountHnyOrWxDai`, `stableRequestAmount`, `beneficiary`, `from`, `chainId` | Unsigned preview. | Invalid amount/beneficiary, missing `from`, policy/simulation failure. |
| `onehive_governance_stakeTx` | Build `stakeToProposal` or `stakeAllToProposal` preview. | `proposalId`, `amountHny` or `all`, `from`, `chainId` | Unsigned preview. | Invalid amount, proposal/state issues, policy/simulation failure. |
| `onehive_governance_withdrawTx` | Build `withdrawFromProposal` or `withdrawAllFromProposal` preview. | `proposalId`, `amountHny` or `all`, `from`, `chainId` | Unsigned preview. | Invalid amount, proposal/state issues, policy/simulation failure. |
| `onehive_governance_executeTx` | Build executable proposal preview after state checks. | `proposalId`, `from`, `chainId` | Unsigned preview. | Already executed/closed/not executable, simulation failure. |
| `onehive_governance_cancelTx` | Build cancel preview when ABI/permissions allow it. | `proposalId`, `from`, `chainId` | Unsigned preview. | Already executed/closed, permission/simulation failure. |
| `onehive_decision_getVote` | Read a Decision / Disputable Voting vote. | `voteId`, optional `voter`, `chainId` | Vote settings/state and optional voter state. | RPC failure, unknown vote. |
| `onehive_decision_newVoteTx` | Build new Decision vote preview. | `context`, optional `executionScript`, `from`, `chainId` | Unsigned preview. | Dangerous/invalid script, missing `from`, policy/simulation failure. |
| `onehive_decision_voteTx` | Build yes/no vote preview. | `voteId`, `supports`, `from`, `chainId` | Unsigned preview. | Closed vote, no voting power/permission, simulation failure. |
| `onehive_decision_executeTx` | Build execute-vote preview. | `voteId`, `executionScript`, `from`, `chainId` | Unsigned preview. | Not executable, script mismatch/risk, simulation failure. |

## Honey token and swap tools

| Tool | Purpose | Key inputs | Output | Typical failures / warnings |
| --- | --- | --- | --- | --- |
| `onehive_honey_quote` | Quote HNY buy/sell on Honeyswap. | `side`, `exact`, `amount`, optional path/tokens, `slippageBps`, `recipient`, `chainId` | Quote, reserves, price impact, slippage bounds, expiring `quoteId`. | Unsupported path, router/reserve failure, high impact warning. |
| `onehive_honey_approveTx` | Build exact ERC-20 approval preview. | `token`, `spender`, `amount`, `unlimited`, `unlimitedApprovalConfirmation`, `from`, `chainId` | Unsigned approval preview. | Unlimited approval missing explicit phrase, missing `from`, policy/simulation failure. |
| `onehive_honey_swapTx` | Build swap preview from a fresh quote. | `side`, `exact`, `amount`, path/tokens, `slippageBps`, `recipient`, `deadlineMinutes`, `quoteId`, `from`, `chainId` | Unsigned swap preview with refreshed quote/reserve checks. | Stale/tampered/mismatched quote, high slippage/impact, missing allowance, simulation failure. |

## Agreement / Celeste tools

| Tool | Purpose | Key inputs | Output | Typical failures / warnings |
| --- | --- | --- | --- | --- |
| `onehive_celeste_getAgreementState` | Read Agreement signer, action, challenge, and collateral state. | `actionId`, `signer`, `disputableApp`, `chainId` | Agreement state summaries and collateral requirements. | RPC failure, missing action/signer data. |
| `onehive_celeste_signAgreementTx` | Build Agreement `sign(settingId)` preview. | `settingId`, `from`, `chainId` | Unsigned preview. | Missing `from`, already signed/permission/simulation issues. |
| `onehive_celeste_challengeActionTx` | Build challenge preview. | `actionId`, `settlementOfferHny`, `finishedEvidence`, `context`, `from`, `chainId` | Unsigned preview with collateral-risk warnings. | Non-challengeable state, collateral/allowance/simulation failure. |
| `onehive_celeste_settleActionTx` | Build settlement preview. | `actionId`, `from`, `chainId` | Unsigned preview. | Not settleable or simulation failure. |
| `onehive_celeste_disputeActionTx` | Build dispute preview. | `actionId`, `submitterFinishedEvidence`, `from`, `chainId` | Unsigned preview with collateral-risk warnings. | Not disputable, collateral/allowance/simulation failure. |
| `onehive_celeste_submitEvidenceTx` | Build evidence submission preview. | `disputeId`, `evidence`, `finished`, `from`, `chainId` | Unsigned preview. | Invalid evidence/ref, closed evidence period, simulation failure. |
| `onehive_celeste_closeActionTx` | Build close-action preview. | `actionId`, `from`, `chainId` | Unsigned preview. | Not closeable or simulation failure. |

## Court and oracle tools

| Tool | Purpose | Key inputs | Output | Typical failures / warnings |
| --- | --- | --- | --- | --- |
| `onehive_oracle_status` | Read Honey price, court fee, and collateral updater status. | none | Oracle/updater read status. | RPC failure or stale updater warning. |
| `onehive_oracle_updatePriceTx` | Placeholder update preview path. | none | Currently fails closed. | `not_implemented`. |
| `onehive_oracle_updateCourtFeesTx` | Placeholder court-fee update path. | none | Currently fails closed. | `not_implemented`. |
| `onehive_oracle_updateCollateralRequirementsTx` | Placeholder collateral update path. | none | Currently fails closed. | `not_implemented`. |
| `onehive_court_status` | Read Celeste term/liveness status from RPC. | `chainId`, `verifyCode` | Current term, term duration, needed transitions, bytecode status. | RPC failure, needed-transition warning. |
| `onehive_court_heartbeatTx` | Build `heartbeat(uint64)` preview. | `maxTransitions`, `from`, `chainId` | Unsigned preview. | No transitions needed, transition cap/state/simulation failure. |
| `onehive_court_subgraphStatus` | Check Celeste/Agreement subgraph health. | `chainId`, endpoint URLs, `maxIndexedAgeSeconds` | Endpoint sources, redacted URLs, schema/freshness/RPC term comparisons. | Missing endpoints, stale or schema-degraded subgraphs; does not block RPC-backed flows. |
| `onehive_court_stakeTx` | Build Celeste registry `stakeFor` HNY preview. | `amountHny`, optional `juror`, `data`, `from`, `chainId` | Unsigned preview. | Missing HNY allowance, invalid amount, simulation failure. |
| `onehive_court_activateTx` | Build juror activation preview. | `amountHny`, `from`, `chainId` | Unsigned preview. | Invalid amount, insufficient inactive stake, simulation failure. |
| `onehive_court_deactivateTx` | Build juror deactivation preview. | `amountHny`, `from`, `chainId` | Unsigned preview with keeper-duty warnings. | Invalid amount, locked/assigned stake constraints, simulation failure. |
| `onehive_court_unstakeTx` | Build unstake preview. | `amountHny`, `from`, `chainId` | Unsigned preview. | Invalid amount, insufficient unlocked stake, simulation failure. |
| `onehive_court_commitTx` | Build keeper vote commit preview. | `voteId` or `disputeId`/`roundId`, `commitment` or `outcome`+`salt`, `juror`, `from`, `chainId` | Unsigned preview; secrets are not decoded into output. | Missing/invalid bytes32 salt or commitment, invalid outcome, simulation failure. |
| `onehive_court_revealTx` | Build keeper vote reveal preview. | `voteId` or `disputeId`/`roundId`, `outcome`, `salt`, `juror`, `from`, `chainId` | Unsigned preview warning that outcome/salt become public. | Invalid salt/outcome, wrong voting phase, simulation failure. |
| `onehive_court_appealTx` | Build appeal or confirm-appeal preview. | `disputeId`, optional `roundId`, `outcome`/`ruling`, `confirm`/`mode`, `from`, `chainId` | Unsigned preview with appeal-deposit warnings. | Missing fee-token allowance, invalid round/outcome, simulation failure. |
| `onehive_court_rewards` | Read juror reward eligibility. | `disputeId`, optional `roundId`, `juror`, `from`, `chainId` | Reward/coherence/settled status. | RPC failure or not eligible. |
| `onehive_court_claimRewardsTx` | Build reward settlement preview. | `disputeId`, optional `roundId`, `juror`, `from`, `chainId` | Unsigned preview. | Already rewarded, no eligible weight, simulation failure. |

## Simulation and submit tools

| Tool | Purpose | Key inputs | Output | Typical failures / warnings |
| --- | --- | --- | --- | --- |
| `onehive_tx_simulate` | Re-run `eth_call`/gas estimation for a preview. | `tx`, `chainId` | Simulation and recomputed policy details. | Wrong chain, missing bytecode, revert, malformed preview. |
| `onehive_tx_submit` | Confirmation-gated handoff/submission. | `tx`, `confirmationPhrase`, `signerMode`, mode-specific fields | Safe/keystore/signer/fork result. | Confirmation mismatch, recomputed preflight failure, unsupported mode, signer rejection. |

## Agent integration boundary

Pi/Bee or other agent packages may wrap this CLI for workflow/user-intent checks, but those wrappers are not part of this repository and are not separate signing authorities. Final authorization remains in the external Safe wallet, interactive keystore unlock, or signer-daemon policy.

## Kleros candidate inspection

`honey kleros status --chain ID --core ADDRESS --expected-token ADDRESS --json`

All three flags are required. Use explicitly reviewed addresses for the selected chain; no Kleros deployment defaults are supplied. This reads the core's staking token, sortition link and pause flags, then the sortition strategy and raw staking total. It checks deployed code, expected token and the reverse core link. It does not certify an implementation, enable submission or compute eligibility. No wallet connection is needed. See [source coverage and limitations](../src/kleros-court/README.md).

`honeyArbitrationFeesAccepted` reports the core’s ERC20 fee allowlist entry for the expected staking token. It does not prove Honey-only appeals; the currently inspected classic appeal path still requires contract work.

## Agreement / Kleros bridge inspection

`honey kleros adapter-status --chain ID --core ADDRESS --expected-token ADDRESS --adapter ADDRESS --agreement ADDRESS [--dispute ID] --json`

All address/chain flags are explicit. Reads validate adapter/Core/Honey/Agreement bindings and the fee recipient/token; optional dispute IDs are uint256 decimal strings. The returned fee is in raw Honey units. A final translated ruling is not proof that Agreement resolved or the proposal executed. No new signing target is enabled.

`honey disputes sign SETTING_ID --from ADDRESS --chain ID --json` exposes the existing unsigned Agreement `sign` preview builder directly. Inspect the actual agreement terms before signing; approval and submission still go through `honey submit` and the wallet. The historical internal tool name contains `celeste`, but this command calls Agreement itself.

### Honey/Kleros juror target stake

`kleros stake --chain ID --core ADDRESS --expected-token ADDRESS --from ADDRESS --court ID --amount HNY` maps to `onehive_kleros_stakeTx`. Returns an unsigned simulated preview. Amount is the total target stake (zero requests unstaking), with at most 18 decimals. Requires explicit Honey/Core linkage and 18-decimal token. Separate allowance may be needed; changes can be delayed. Submission remains policy-blocked pending reviewed deployment bindings.
