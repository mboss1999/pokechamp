#!/usr/bin/env bash
# Show the status and log tail of the latest (or given) run.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
RUN_ID="${1:-$(cat aws/.last-run)}"

echo "Run $RUN_ID"
aws ec2 describe-instances --region "$REGION" \
	--filters "Name=tag:Name,Values=champions-sim-$RUN_ID" \
	--query 'Reservations[].Instances[].[InstanceId,State.Name,InstanceType,LaunchTime]' --output text
echo "status: $(aws s3 cp "s3://$BUCKET/runs/$RUN_ID/status" - 2>/dev/null || echo starting)"
aws s3 cp "s3://$BUCKET/runs/$RUN_ID/run.log" - 2>/dev/null | grep '^\[' | tail -8 || true
