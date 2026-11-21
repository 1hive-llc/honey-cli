# ABI locks for Gnosis Chain ID 100

Mainnet write tools must not be enabled until required ABI locks are created here.

Each lock file must use this shape:

```ts
type AbiLock = {
  chainId: 100;
  name: string;
  address: `0x${string}`;
  source: 'verified-explorer' | 'official-repo' | 'manual-reviewed';
  abiSha256: string;
  bytecodeHash: `0x${string}`;
  selectors: Record<string, `0x${string}`>;
  reviewedAt: string;
  reviewer: string;
};
```

Required before mainnet write previews:

- `convictionVoting.json`
- `agreement.json`
- `hny.json`
- `wxDai.json`
- `honeyswapRouter02.json`
- `honeyswapFactory.json`
- `uniswapV2Pair.json`
- `priceOracleUpdater.json`
- `feesUpdater.json`
- `collateralUpdater.json`

Optional, only after review:

- `disputableVoting.json`
- `hookedTokenManager.json`
- `agentVault.json`
- `celesteCourt.json`
- `celesteRegistry.json`
- `celesteVoting.json`

Codex task: implement a verifier that fails policy checks if a write target lacks a matching ABI lock.
