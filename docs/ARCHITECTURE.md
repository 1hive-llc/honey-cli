# Architecture

`honey-cli` is the standalone operator and signing boundary for Honey/1Hive operations. The repository currently keeps the neutral protocol layer and command layer together so the first extraction is small and reviewable.

## Layers

```text
honey-cli commands
  -> src/onehive public seam
     -> protocol reads, previews, simulation, policy, signer protocol
        -> unsigned Safe handoff / interactive keystore / signer daemon
```

### Neutral protocol layer: `src/onehive/**`

Owns canonical addresses, schemas, reviewed ABI fragments and locks, RPC/subgraph clients, read models, unsigned transaction builders, simulation, preflight, policy checks, keystore/signing protocol, and the tool registry.

It must not import Pi, Bee, terminal-only UI, prompts, or agent skills. Builders remain unsigned and submit-time checks are recomputed from exact transaction fields.

### CLI layer: `src/honey-cli.ts`, `src/honey-signer.ts`, `bin/**`

Owns command names and flags, stdin/file handling, human summaries, stable JSON output, exit-code behavior, keystore setup commands, and signer-daemon lifecycle. It calls the public `src/onehive/index.ts` seam rather than deep-importing internal tool modules.

## Authority boundary

The CLI prepares and checks a preview. Manual Safe signing or an interactive human unlock provides human approval; a signer daemon/external signer owns unattended unlock/signing under its own policy. No private key, passphrase, seed phrase, or mnemonic may enter CLI arguments, tool JSON, logs, prompts, or audit records.

A future Bee package may invoke `honey` as an executable or consume intentionally stable core exports. It must not copy protocol policy or become a secret-custody/final-approval layer.

## Contract tests

- `test/onehive/core-exports.test.ts` protects the public seam.
- `test/onehive/contracts.test.ts` protects result, preview, signer-protocol, JSON, and exit-code contracts.
- `test/onehive/package-boundaries.test.ts` protects protocol/CLI independence from Pi/Bee paths.
