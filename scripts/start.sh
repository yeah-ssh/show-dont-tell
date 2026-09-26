#!/usr/bin/env bash
# Starts everything for a local run: browser-lab MCP (:8900) and TrueForge (:8790),
# then configures TrueForge. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Missing .env. Run: cp .env.example .env  (then fill it in)"; exit 1; }
command -v ffmpeg >/dev/null || { echo "ffmpeg is required (brew install ffmpeg / apt install ffmpeg)"; exit 1; }
node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=14)?0:1)' \
  || { echo "Node >= 22.14 is required"; exit 1; }

python3 -c "import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)" || { echo "python3 must be 3.10+ (TrueForge sandbox). brew install python"; exit 1; }
[ -d node_modules ] || npm install
npx playwright install chromium firefox >/dev/null

mkdir -p .logs
npm run lab > .logs/browser-lab.log 2>&1 &
LAB_PID=$!
SERVER_EXECUTION_TIMEOUT_SECONDS=1800 MCP_REQUEST_TIMEOUT_MS=120000 \
OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' \
  npx -y @truefoundry/trueforge@0.2.1 > .logs/trueforge.log 2>&1 &
TF_PID=$!
trap 'kill $LAB_PID $TF_PID 2>/dev/null' EXIT INT TERM

echo "Starting browser-lab and TrueForge (logs in .logs/)..."
for _ in $(seq 1 60); do
  curl -sf localhost:8900/healthz >/dev/null && curl -sf localhost:8790/healthz >/dev/null && break
  sleep 2
done
node scripts/bootstrap.mjs
echo
echo "Ready: open http://localhost:8790, pick the ticket-resolver agent, and say: Resolve <ISSUE-ID>"
wait
