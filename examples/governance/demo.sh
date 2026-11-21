#!/bin/bash
# Local fixtures only. Never select a profile or a live RPC.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [ ! -x node_modules/.bin/vitest ]; then
  echo 'Missing Honey CLI dependencies. Run npm ci --ignore-scripts from the repository root first.' >&2
  exit 1
fi
case "${1:-jury}" in
  jury|appeal)
    mode=
    [ "${1:-jury}" != appeal ] || mode=1
    exec env HONEY_DEMO_APPEAL="$mode" HONEY_DEMO_ESCALATION= HONEY_DEMO_PARTY_EVIDENCE= HONEY_DEMO_DRAWING= HONEY_DEMO_ZERO_ALLOWANCE= node --import tsx examples/governance/preview.ts ;;
  --check) npm run typecheck; exec node_modules/.bin/vitest run test/web test/kleros-court ;;
  *) echo 'Usage: bash demo.sh [jury|appeal|--check]' >&2; exit 2 ;;
esac
