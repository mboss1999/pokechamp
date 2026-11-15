#!/usr/bin/env bash
# Progress of a sharded run (aws/launch-sharded.sh): each shard's machine, status and recent log lines.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
GROUP="${1:-$(cat aws/.last-sharded)}"
echo "Group $GROUP"
awk '$1 == "shard" {r[$2] = $3} END {for (k in r) print k, r[k]}' "aws/.sharded-$GROUP" | sort -n | while read -r k RUN; do
	STATE="$(aws ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=champions-sim-$RUN" \
		--query 'Reservations[].Instances[].State.Name' --output text)"
	echo "-- shard $k  run $RUN  machine: ${STATE:-none}  status: $(aws s3 cp "s3://$BUCKET/runs/$RUN/status" - 2>/dev/null || echo starting)"
	aws s3 cp "s3://$BUCKET/runs/$RUN/run.log" - 2>/dev/null | grep '^\[' | tail -${LINES_PER_SHARD:-3} || true
done
echo "shared: $(aws s3 ls "s3://$BUCKET/runs/$GROUP/shared/" --recursive | awk '{print $4}' | sed "s|runs/$GROUP/shared/||" | tr '\n' ' ')"
