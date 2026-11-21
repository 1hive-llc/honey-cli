# Encrypted keystore

Encrypted keystore signing is a Honey CLI signing backend. It supports two different use cases:

1. **interactive keystore** for advanced local/manual signing when a human is present; and
2. **automated keystore / signer daemon** for unattended automation with strict policy and no agent-readable secrets.

It is not a shortcut around transaction safety: `onehive_tx_submit` still requires the exact preview confirmation phrase, recomputes submit-time preflight checks, requires a matching encrypted account, and enforces an explicit keystore policy before signing.

For most users, an unsigned Safe handoff is the default. Use keystores when you specifically want local signing or automation infrastructure.

## Files

Defaults:

- `HONEY_KEYSTORE_DIR=.pi/keystore`
- `HONEY_KEYSTORE_POLICY=.pi/keystore/policy.json`
- `HONEY_KEYSTORE_PASSPHRASE_FILE=`

`.pi/keystore/` is ignored by git. Back it up securely and keep any passphrase file outside version control. If an agent can read both the keystore file and the passphrase file, it can decrypt/sign with the key; use that setup only for low-value testing or carefully isolated automation.

## Create or import

Generate a new key:

```bash
HONEY_KEYSTORE_PASSPHRASE_FILE=/path/to/passphrase.txt \
  honey keystore generate --label heartbeat-bot --json
```

Import an existing key via stdin, never as an argument:

```bash
printf '%s' "$PRIVATE_KEY" | \
HONEY_KEYSTORE_PASSPHRASE_FILE=/path/to/passphrase.txt \
  honey keystore import --label heartbeat-bot --expected-address 0x... --json
```

The CLI rejects `--passphrase`, `--keystore-passphrase`, and `--private-key` argument values because shell history and process lists leak them.

## Policy

Keystore signing fails closed unless a policy file authorizes the exact account/action.

Built-in policy presets:

- `safe-automation` — default. Allows only Conviction Voting support/unsupport (`stakeToProposal`, `stakeAllToProposal`, `withdrawFromProposal`, `withdrawAllFromProposal`) and Celeste court `heartbeat`; zero native value; max risk `medium`.
- `full-governance` — allows governance/Celeste operations including proposal creation/execution/cancel, Decision votes, Agreement challenge/dispute/evidence/close, court staking/keeper/appeal/reward methods; excludes swaps, token transfers, and token approvals; zero native value; max risk `critical`.
- `full-access` — no keystore-level method/selector restriction and no native-value cap, so submit-time allowlist/ABI/preflight policy decides; includes swaps/transfers/approvals when those previews are otherwise allowed; max risk `critical`.

`maxRisk` is a coarse cap over the preview's built-in risk label (`low < medium < high < critical`). It is not a dollar/token cap; it is a last-resort category gate. The labels are currently assigned by builders: support/unsupport and heartbeat are `medium`, swaps and many governance/Celeste actions are `high`, and especially dangerous future actions can be `critical`.

`maxValueWei` caps native xDAI sent as `tx.value`; it does not cap HNY/WXDAI ERC-20 amounts. The default `safe-automation` and `full-governance` policies keep native value at `0`. `full-access` intentionally leaves `maxValueWei` unset so native xDAI routes can be supported once the router builders/preflight support them.

Amount caps are intentionally not part of the default support/heartbeat policy. They make more sense as future custom-policy fields for collateral-risking challenges, appeals, commitments, native xDAI routes, and rate-limited keeper actions.

Generate or write a preset with:

```bash
honey keystore default-policy \
  --preset safe-automation \
  --account 0x... \
  --label heartbeat-bot \
  --write \
  --json
```

For broader governance automation without swaps/transfers:

```bash
honey keystore default-policy --preset full-governance --account 0x... --write --json
```

For full local authority over all currently allowlisted/ABI-locked Honey operations, including swaps/transfers:

```bash
honey keystore default-policy --preset full-access --account 0x... --write --json
```

Example `safe-automation` policy shape:

```json
{
  "version": 1,
  "accounts": [
    {
      "label": "heartbeat-bot",
      "address": "0x0000000000000000000000000000000000000000",
      "allowedChainIds": [100],
      "allowedTargets": ["0x44E4fCFed14E1285c9e0F6eae77D5fDd0F196f85"],
      "allowedMethods": [
        "stakeToProposal",
        "stakeAllToProposal",
        "withdrawFromProposal",
        "withdrawAllFromProposal",
        "heartbeat",
        "ConvictionVoting.stakeToProposal",
        "ConvictionVoting.stakeAllToProposal",
        "ConvictionVoting.withdrawFromProposal",
        "ConvictionVoting.withdrawAllFromProposal",
        "CelesteCourt.heartbeat"
      ],
      "allowedSelectors": [
        "0xfc370051",
        "0x1df67d2f",
        "0x649c649c",
        "0x4fb3cbbc",
        "0x9bf6fa57"
      ],
      "maxValueWei": "0",
      "maxRisk": "medium"
    }
  ]
}
```

Prefer very narrow policies. Use a manual Safe handoff for treasury movement, governance, large value, uncertain calldata, or collateral-risking actions outside the account's explicit purpose. Safe/module constraints are useful later account-authority hardening, but they are intentionally not required for the initial signer-daemon model.

## Interactive submit

Build a preview as usual, review it, then submit with keystore mode. For the release direction, Honey CLI should prefer interactive TTY unlock for this human-present path. The current passphrase-file support is a prototype/local automation mechanism and should not be used where the agent can read the passphrase file.

Example:

```bash
honey submit preview.json \
  --keystore \
  --keystore-account heartbeat-bot \
  --confirm "<exact confirmation phrase>" \
  --json
```

The submit path signs only after:

1. exact confirmation phrase matches the preview and recomputed phrase;
2. RPC chain, target bytecode, allowlist, selector/ABI-lock, decoded method, and simulation checks pass;
3. keystore account matches `tx.from`;
4. keystore policy authorizes chain, target, selector/method, value, and risk;
5. interactive TTY unlock decrypts the local keystore.

Audit records are appended to `.pi/sessions/onehive-audit.log` with keystore label/address metadata only. Private keys and passphrases are never written intentionally, but Node cannot guarantee perfect memory zeroization.

## Prototype/test passphrase-file mode

In-process passphrase-file signing is available only with explicit opt-in:

```bash
HONEY_KEYSTORE_ALLOW_PASSPHRASE_FILE=1 \
HONEY_KEYSTORE_PASSPHRASE_FILE=/path/to/passphrase.txt \
  honey submit preview.json --keystore --keystore-account heartbeat-bot --confirm "..."
```

Use this only for tests, low-value prototypes, or carefully isolated hosts where the agent cannot read the passphrase file. If the agent can read both the keystore file and passphrase file, encryption at rest does not protect the key from that agent.

## Automation direction

For unattended automation, the preferred release architecture is a separate `honey-signer` daemon or external signer protocol. Honey CLI can manage the local listener lifecycle without exposing the key/passphrase to Bee:

```bash
honey signer start --keystore heartbeat-bot --socket .pi/honey-signer.sock
honey signer status --json
honey signer stop --json
```

In the current prototype, non-interactive daemon startup can use `HONEY_KEYSTORE_ALLOW_PASSPHRASE_FILE=1` plus `HONEY_KEYSTORE_PASSPHRASE_FILE`. In a secure deployment, the signer process should run outside the agent sandbox and obtain its unlock secret from a non-agent-readable path, operator TTY, OS keychain, service manager, or another deterministic host mechanism.

The signer flow is:

```text
bee / script / agent
  -> honey-cli preview + submit request
     -> honey-signer policy
        -> sign/submit if allowed
```

The signer daemon owns unlock/signing and enforces policy. The agent should never be able to read the keystore passphrase or decrypted private key.

Safe, multisig, module, and session-key constraints can be added later as account-authority hardening, but the initial automation path should stay simple: signer daemon plus strict policy and a narrowly funded/account-limited key.
