# Local Honey governance simulator

From a source checkout, run `npm ci --ignore-scripts`, then
`bash examples/governance/demo.sh jury` or `bash examples/governance/demo.sh appeal`.
Open the loopback address printed by the launcher. Press Ctrl-C to stop it.
These run against synthetic fixture records, not an RPC or a wallet. They
cannot sign or submit transactions and do not prove a live deployment.

Run `bash examples/governance/demo.sh --check` for the focused CLI and web
tests, or `npm run check` for the full project suite.
