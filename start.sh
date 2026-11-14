#!/usr/bin/env bash
# Start the team builder UI. Uses the bundled Node in .tools/ when node isn't installed.
cd "$(dirname "$0")"
NODE="$(command -v node || echo .tools/node/bin/node)"
(sleep 1; open "http://localhost:${PORT:-5173}") &
exec "$NODE" web/serve.cjs "${PORT:-5173}"
