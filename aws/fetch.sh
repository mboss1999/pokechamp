#!/usr/bin/env bash
# Download a finished run's results into the web app.
set -euo pipefail
cd "$(dirname "$0")/.."
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
RUN_ID="${1:-$(cat aws/.last-run)}"

STATUS="$(aws s3 cp "s3://$BUCKET/runs/$RUN_ID/status" - 2>/dev/null || echo starting)"
if [ "$STATUS" != done ]; then
	echo "Run $RUN_ID is not finished (status: $STATUS)."
	exit 1
fi
mkdir -p "out-aws/$RUN_ID" web/data
aws s3 sync "s3://$BUCKET/runs/$RUN_ID/out" "out-aws/$RUN_ID" --quiet
cp "out-aws/$RUN_ID/results.json" web/data/results.json
echo "Installed results from run $RUN_ID into web/data/results.json"
