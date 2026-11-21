# honey-cli


Standalone Honey/1Hive command-line interface and signer boundary for Gnosis Chain.

`honey-cli` provides a stable operator surface for humans, scripts, and agent stacks. It includes the neutral protocol layer that builds and checks Honey/1Hive reads and transaction previews, with an unsigned Safe handoff by default and optional signing through an interactive keystore or a constrained signer daemon.

## Quick start

Requires Node.js 22+ and npm.

```bash
cp .env.example .env
npm install
npm run check
npm audit --audit-level=high --omit=dev
npm pack --dry-run --json
./bin/honey.mjs signer status --json
```

Use `GNOSIS_RPC_URL` for read-only chain access. Indexed reads may need `THE_GRAPH_API_KEY`. Keep `.env`, keystores, passphrase files, wallet sessions, and runtime logs outside Git.

## Commands

```bash
./bin/honey.mjs token info --json
./bin/honey.mjs token balance 0x... --json
./bin/honey.mjs proposals list --limit 5 --json
./bin/honey.mjs proposals show 213 --json
./bin/honey.mjs proposals forecast 213 --json
./bin/honey.mjs token quote --side buy --input 1 --json
./bin/honey.mjs court status --json
```

Transaction builders emit unsigned previews:

```bash
./bin/honey.mjs proposals stake 213 --amount 1 --from 0x... --json > preview.json
./bin/honey.mjs submit preview.json --confirm "<exact confirmation phrase>" --json
```

The default submit path returns an unsigned Safe handoff. It does not sign or broadcast. Mobile approval via WalletConnect is not included in this release. Keystore and signer-daemon commands are documented in [`docs/KEYSTORE.md`](docs/KEYSTORE.md). Never put private keys or passphrases in command arguments.

## Architecture

```text
honey-cli command layer
  -> src/onehive public seam
     -> reads / unsigned builders / simulation / deterministic policy
        -> unsigned Safe handoff / interactive keystore / signer daemon
```

The protocol layer must remain independent of Pi and Bee. A future Bee package can invoke this CLI or consume stable core exports, but it does not own secrets or final approval.

Read [`docs/CLI_CONTRACT.md`](docs/CLI_CONTRACT.md), [`docs/SAFETY_MODEL.md`](docs/SAFETY_MODEL.md), and [`docs/SIGNING_BOUNDARY.md`](docs/SIGNING_BOUNDARY.md) before changing the submit or signer paths.

## Licensing

Original Honey CLI material is licensed under the [MIT License](LICENSE).
See [third-party notices](THIRD_PARTY_NOTICES.md) for dependency and protocol reference boundaries.

## Governance simulator

Run the [offline governance example](examples/governance/README.md) from a
source checkout to explore synthetic jury and appeal flows. It needs no RPC or wallet.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for local checks and pull requests,
and [SECURITY.md](SECURITY.md) for private vulnerability reporting.
