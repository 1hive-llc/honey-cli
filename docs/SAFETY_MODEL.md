# Safety model

## Default mode

The agent is read-only by default. Write-capable builder tools produce transaction previews, not signatures.

## Transaction safety gates

A transaction may only be submitted if all of the following pass:

- Chain is Gnosis Chain ID 100 or explicitly selected test/fork mode.
- Target contract is allowlisted.
- Target contract has bytecode.
- ABI selector is known and ABI lock exists.
- Decoded preview method matches the locked calldata selector.
- Simulation succeeds at submit time.
- Confirmation phrase matches exactly.
- Signer mode is not `dev-private-key` on mainnet.

## Signing, approval, and account authority model

The system separates signing/approval from account authority:

- **Manual Safe signing** is the default human-in-the-loop approval path. Honey prepares and policy-checks a preview, but a human wallet signs or rejects.
- **Interactive keystore** is an advanced local/manual signing path. Honey CLI prompts through a non-transcript secret channel; Bee/Pi must not receive the passphrase.
- **Signer daemon / external signer** is the unattended automation path. The daemon owns unlock/signing, independently checks policy/preflight, and returns submitted/rejected/ambiguous/error results.
- **Raw `dev-private-key`** is local-fork/test-only and remains blocked on Gnosis Chain ID `100`.
- **EOA, Safe/multisig, smart account, module, or session key** are account-authority choices. Safe/module automation is deferred; it is not required for the initial signer-daemon model.

Current implementation:

- Gnosis Chain ID `100`: unsigned Safe manual handoff by default, interactive/policy-gated keystore signing, or external signer/signer daemon requests. No raw mainnet private-key signing.
- Encrypted keystore mode: requires `tx.from`, a matching local encrypted keystore, interactive unlock or explicitly opted-in passphrase-file prototype mode, explicit account policy, successful submit-time simulation, allowlist/bytecode/ABI/selector checks, and exact confirmation.
- External signer mode: Honey submit recomputes preflight and sends a redacted signer-protocol request; the signer must independently recompute preflight/policy before signing.
- Local Gnosis fork chain ID `31337`: `dev-private-key` execution is allowed for E2E tests only, after active-chain verification, successful simulation, required policy passes, and exact confirmation.
- Chiado/test deployments may be readable, but Honey/1Hive production flows should be tested on a local Gnosis fork because current testnets do not mirror the deployed 1Hive system.
- Subgraphs are not forked. Fork E2E readbacks must use RPC receipts, logs, and contract getters.

## Keystore and signer-daemon gates

- Fail closed when no policy file/account entry matches.
- Match signer/keystore address to `tx.from`.
- Restrict allowed chain IDs.
- Restrict targets and selectors/methods for each account.
- Enforce value and risk caps.
- Never accept private keys or passphrases through CLI args, Pi tool JSON, prompts, or audit logs.
- Treat local signer socket access as signing-request authority; protect the socket/host and use narrow policy/funding.
- Escalate to manual Safe review for treasury movement, high-risk actions, unknown calldata, or anything outside policy.

## Honey trading gates

- Quote first.
- Quote expires after 60 seconds by default.
- Price impact and slippage are checked.
- Recipient must be explicit.
- Exact approvals are default.
- Unlimited approvals require an explicit phrase.

## Celeste gates

Celeste and Agreement challenge/dispute operations can risk collateral. The agent must read state and collateral requirements, explain consequences, and simulate before any submission handoff.
