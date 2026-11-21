# Authority and signing model

This project separates three concerns that are easy to conflate:

1. **Decision-making** — what `bee`, a human, script, or another agent decides should happen.
2. **Signing / approval** — who can produce the signature or approval needed to act.
3. **Account authority** — what the signed action is allowed to do on-chain.

The target product direction is for `honey-cli` to be the stable Honey/1Hive automation and signing boundary. `bee` should be able to call or wrap that boundary, and other agent stacks should be able to do the same without importing Pi-specific code.

See also `docs/SIGNING_BOUNDARY.md`.

## Signing / approval layer

This layer answers: **who can produce a signature or approval?**

### Manual approval outside Honey CLI

The default submit path returns an unsigned Safe handoff. Review the chain, target, calldata and value independently in your Safe before signing. The CLI cannot report whether that external transaction was approved.

### Interactive keystore: advanced local/manual signing

Interactive keystore signing is an alternative human-present path for users who want to sign locally.

Use it when:

- a human is at the terminal;
- the user accepts local key custody;
- the passphrase can be entered through a TTY or other non-transcript secret channel;
- the action still passes Honey CLI preflight and keystore policy.

This is similar to manual signing in that a human is present at signing time, but it has more key-management burden. Passphrases and private keys must not travel through CLI args, Pi tool JSON, prompts, chat, or logs.

### Automated keystore / signer daemon: unattended automation

Unattended automation should use a separate Honey signer daemon or external signer boundary.

Use it for explicitly configured autonomous roles, such as:

- court heartbeat / liveness maintenance;
- low-risk keeper operations;
- small-value reward claims or routine operations under configured caps;
- other narrowly allowlisted actions.

The signer daemon owns unlock/signing and enforces deterministic policy. `bee`, scripts, and other agents request signatures/submissions but cannot read the private key or passphrase.

The keystore must not become an unrestricted treasury/governance key. If software can repeatedly request signatures, the key should be treated as autonomous authority and constrained by policy, funding, host permissions, and later optional on-chain limits.

### Test-only private keys

Raw private-key signing remains test/fork-only. It must stay blocked on Gnosis Chain ID `100`.

## Account authority layer

This layer answers: **what can the signer do on-chain?**

Initial release should keep this simple: a narrowly funded/account-limited EOA plus Honey CLI/signer policy is sufficient for most automation.

Safe, multisig, smart-account, module, and session-key restrictions are account-authority enhancements, not required initial signing paths. They can be revisited later after the Honey CLI signer boundary is stable.

## Policy layers

Autonomy should not rely on prompts alone. The intended stack is:

1. **Bee autonomy policy** — should the agent attempt this or escalate?
2. **Honey CLI policy** — deterministic checks on chain, target, ABI, simulation, value, stale quotes, collateral risk, and configured autonomy limits.
3. **Signing backend policy** — the Safe handoff requires separate human approval; interactive keystore requires human unlock; signer daemon refuses disallowed chains/actions/accounts.
4. **Account authority policy** — optional future Safe, smart-account, module, or session-key restrictions.

## Bee boundary

`bee` should not be the final signing approval boundary. It may show previews, explain risks, ask whether to proceed with a handoff, or invoke Honey CLI commands, but final authorization belongs to:

- external wallet UI for manual Safe signing;
- Honey CLI interactive unlock for manual keystore signing;
- signer-daemon/external-signer policy for unattended automation.

Existing Pi approval UI should be treated as a workflow/user-intent guard, not as secret custody or wallet approval.

## Product direction

Near term:

- Keep manual Safe review as the default user approval path.
- Keep interactive keystore as an advanced local/manual alternative.
- Treat passphrase-file/in-process keystore signing as prototype/local automation only when the agent cannot read the secret or the risk is acceptable.
- Keep raw `dev-private-key` restricted to local forks/tests.

Medium term:

- Move unattended automation toward a `honey-signer` daemon or external signer protocol with explicit account labels, chain restrictions, method allowlists, value caps, risk caps, audit logs, and no agent-readable secrets.
- Let `bee` call `honey-cli` for autonomous operations only when its autonomy policy allows the requested command.
- Escalate to manual Safe review when the operation exceeds autonomous authority.

Long term:

- Consider Safe/module/session-key authority only as an optional hardening layer after the signer boundary is stable.
- Keep manual Safe review as the escalation path for actions requiring human review.
- If a webapp emerges, it can reuse the same underlying transaction preview and policy model while providing a more casual human review interface.
