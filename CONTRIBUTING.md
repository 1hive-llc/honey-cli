# Contributing to Honey CLI

Use Node.js 22. From a clean checkout:

```sh
npm ci --ignore-scripts
npm run check
```

Open a pull request that describes the change, why it is needed, and how it
was tested. Include a regression test for behavior changes. Use synthetic
fixtures or the [offline governance simulator](examples/governance/README.md).
CI does not use live RPCs, sign transactions, or require contributor secrets.

Do not include real keys, credentials, private profiles, or wallet session
files. Read the [safety model](docs/SAFETY_MODEL.md) and
[signing boundary](docs/SIGNING_BOUNDARY.md) before changing transaction code.
Report security issues through the [security policy](SECURITY.md), not a
public issue or pull request.
