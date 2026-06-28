#!/bin/zsh
# Unattended GTM run. Dry-run by default; sends ONLY when BOTH are true:
#   - .env has ENABLE_AMPLEMARKET_PUSH=true  (gates the actual send in pipeline.js)
#   - GTM_SEQUENCE is set                    (the target Amplemarket sequence id)
# Collaboration guard in the pipeline leaves any account already in flight alone.
set -e
cd "$(dirname "$0")/.."
mkdir -p logs
NODE=(node --experimental-sqlite --disable-warning=ExperimentalWarning)
ts() { date "+%Y-%m-%dT%H:%M:%S"; }

echo "[$(ts)] === auto-run start ===" >> logs/auto.log

# Pull Trellus dialer sessions into the dashboard (read-only mirror). Non-fatal:
# a Trellus API hiccup must not abort the pipeline run below (set -e is on).
"${NODE[@]}" scripts/sync-trellus.mjs >> logs/auto.log 2>&1 || echo "[$(ts)] trellus sync failed (non-fatal)" >> logs/auto.log

if [ -n "$GTM_SEQUENCE" ]; then
  "${NODE[@]}" src/cli.js pipeline --limit "${GTM_LIMIT:-25}" --send --sequence "$GTM_SEQUENCE" >> logs/auto.log 2>&1
else
  "${NODE[@]}" src/cli.js pipeline --limit "${GTM_LIMIT:-25}" >> logs/auto.log 2>&1
fi

# Reply loop: triage whatever the inbox sync dropped at data/inbox.json (from the
# Amplemarket MCP / your inbox export). Safe — triage only writes an actions file.
if [ -f data/inbox.json ]; then
  "${NODE[@]}" src/cli.js replies data/inbox.json >> logs/auto.log 2>&1
fi
echo "[$(ts)] === auto-run done ===" >> logs/auto.log
