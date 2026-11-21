# Signing boundary

This repository separates **Honey/1Hive signing infrastructure** from **Pi agent UX**.

## Product boundary

### `honey-cli` owns signing/security

`honey-cli` is the stable authority boundary for Honey/1Hive operations. It owns:

- transaction preview and submit formats;
- deterministic preflight and policy checks;
- interactive keystore signing;
- automated keystore/signer-daemon signing;
- audit logs;
- JSON output and exit-code contracts.

Any user, script, Pi agent, or other agent stack should be able to use the same Honey CLI signing surface without importing Pi-specific code.

### `bee` owns Pi integration, not secret custody

`bee` is the Pi-facing package. It owns:

- prompts and skills;
- explanation/review of previews;
- agent intent checks before invoking a submit path;
- escalation guidance;
- thin compatibility wrappers while the repo is being separated.

`bee` should not own signing secrets, passphrases, private keys, or the final signing approval boundary.

A Pi Confirm/Reject dialog can be useful as a workflow guard — “should the agent proceed with this handoff?” — but final authorization belongs to the signer path: wallet UI, Honey CLI interactive unlock, or signer-daemon policy.

## Supported signing paths

### 1. Unsigned Safe handoff (default)

After exact confirmation and successful preflight, the CLI emits transaction details for manual review. It does not sign, broadcast or create a Safe service proposal.

### 2. Interactive keystore — advanced manual path

Alternative human-present signing path for users who want to sign locally.

- `honey-cli` prompts locally for the keystore passphrase through an interactive TTY or equivalent non-transcript secret channel.
- The passphrase is not passed through CLI args, Pi tool JSON, prompts, or logs.

### 3. Automated keystore / signer daemon — automation path

Preferred unattended signing path.

- A separate `honey-signer` daemon or external signer owns keystore unlock/signing.
- `honey-cli`, `bee`, or another agent sends a transaction preview/signing request.
- The signer enforces deterministic policy before signing.
- The agent cannot read the private key or passphrase.
- Honey CLI may start/stop/status the local listener as process management, but unlock secrets must come from outside Bee/Pi tool JSON and, in secure deployments, outside the agent-readable sandbox.

Initial policy should be intentionally narrow: account, chain, target, selector/method, value cap, risk cap, and later optional rate limits.

## Safe / smart-account constraints

Safe, multisig, smart-account, module, and session-key setups are **account-authority layers**, not first-class signing paths for the initial Honey CLI release.

They can be revisited later, but the initial automation model should not require Safe-specific complexity. The simpler default is:

```text
honey-cli preflight/policy
  -> signer daemon policy
     -> sign/submit with a narrowly funded/account-limited key
```

Operators who already use a Safe can still use manual Safe flows. Automated Safe/module support can be added later as an authority enhancement.

## Non-goals

- No raw mainnet private-key environment variables.
- No passphrases or private keys in Pi tool schemas, CLI args, chat, logs, or audit records.
- No generic Pi signing stack assumptions inside this Honey-specific package.
- No requirement that users run Pi to use Honey signing paths.

## Signer protocol v1

External signer requests use a redacted protocol object containing:

- `version: 1`;
- `requestId`;
- `action: "submit"`;
- `previewHash` over chain/from/to/value/data/decoded fields;
- `confirmationPhraseHash`, not the raw phrase;
- optional `account` and `label`;
- redacted `tx` preview with no private key/passphrase fields;
- submit-time preflight summary.

Responses use `submitted`, `rejected`, `ambiguous`, or `error` and may include `txHash`, `signerAuditId`, `message`, and `retryable`. Private keys, passphrases, seed phrases, mnemonics, and password fields are rejected by schema.

## Migration implication

Current in-process keystore signing is acceptable as a prototype when used interactively or with explicit passphrase-file opt-in, but the release direction should be:

1. keep manual Safe review as default;
2. add/keep interactive keystore as an advanced local manual alternative;
3. move unattended automation to a signer daemon or external signer boundary;
4. keep `bee` as a caller/reviewer/escalator, not a secret holder.
