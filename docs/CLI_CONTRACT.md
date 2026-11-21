# Honey CLI contract

This document records the Milestone 10 stability target for `honey-cli`. It is intentionally small and testable so Bee, scripts, and future agent stacks can rely on the CLI without importing Pi-specific code.

## Invocation model

```bash
honey <area> <command> [args]
honey <area> <command> [args] --json
```

- Default output is human-readable and may change for readability.
- `--json` output is the stable automation surface.
- Transaction-building commands return unsigned previews unless explicitly routed through `honey submit`.
- `honey submit` accepts a raw `TxPreview`, `{ "tx": ... }`, or a successful `OneHiveToolResult<TxPreview>` from stdin/file.

## JSON result envelope

All `--json` command output should be a single JSON object using the shared core result shape:

```ts
type OneHiveToolResult<T> =
  | {
      ok: true
      data: T
      warnings?: string[]
      warningDetails?: Array<{ category: string; severity: string; message: string }>
    }
  | {
      ok: false
      error: { code: string; message: string; details?: unknown; retryable?: boolean }
    }
```

Automation should branch on `ok`, not human-readable text.

## Exit codes

Current contract:

- `0`: command completed successfully (`ok: true`) or help was intentionally displayed.
- `1`: validation, policy, runtime, signer, RPC/subgraph, or submission failure (`ok: false` or thrown CLI error).

Future refinement may introduce more specific non-zero categories, but `0`/non-zero will remain stable.

## Stable preview requirements

A transaction preview exposed through `--json` must include:

- chain ID;
- target address;
- calldata;
- native value;
- decoded contract/method summary when safe;
- policy risk/checks;
- confirmation phrase when submission is possible;
- simulation status where required by the builder.

Callers must treat embedded simulation/policy checks as display metadata. `honey submit` and signer paths recompute preflight from exact transaction fields.

## Warning model

- `warnings: string[]` remains for human compatibility.
- `warningDetails[]` is the structured automation field.
- Security/collateral/signing warnings must stay visible in both human and JSON output.

## Areas of responsibility

- `honey token ...` — token metadata, balances, quotes, approvals, swaps.
- `honey proposals ...` — Conviction/funding proposal reads, forecasts, and previews.
- `honey decisions ...` — Decision/Disputable Voting reads and previews.
- `honey disputes ...` — Agreement/Celeste challenge, evidence, settlement, dispute, close flows.
- `honey court ...` — court status, heartbeat, staking, keeper, appeal, rewards.
- `honey keystore ...` — encrypted local keystore metadata/setup.
- `honey signer ...` — local signer-daemon lifecycle.
- `honey submit ...` — exact-confirmation-gated handoff/submission.

## Current Milestone 10 proof point

`honey proposals forecast <id> --json` returns a core `OneHiveToolResult<HoneyProposalForecastOutput>` with projected current conviction, threshold progress, eventual conviction, and estimated pass time if current support remains unchanged.
