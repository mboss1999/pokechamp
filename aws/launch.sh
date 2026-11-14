#!/usr/bin/env bash
# Package the simulator, upload it to S3, and start one EC2 Spot instance that
# runs the pipeline, uploads results to S3, and terminates itself.
#
#   SCALE=4 PASSES=2 aws/launch.sh
#   MATCHUPS_AGENT=rollout4 LADDER_AGENT=rollout4 MATCHUP_K=8 LADDER_GAMES=60000 MAX_HOURS=8 aws/launch.sh
#   RESUME_RUN=20261022-123456 ...same settings... aws/launch.sh      # continue after an interruption
#   COMMAND='node sim/bench.js turn --level h-16x16 --dir out' aws/launch.sh   # any other job (see sim/bench.js)
#
# Env: SCALE (sample-size multiplier, default 4), PASSES (set-tuning passes, default 2),
#      AGENT (battle AI for every stage: heuristic | rollout2 | rollout4, default heuristic),
#      SETS_AGENT / MATCHUPS_AGENT / LADDER_AGENT (per-stage override of AGENT),
#      MATCHUP_K (battles per matchup pair) and LADDER_GAMES (team battles), default from SCALE,
#      RESUME_RUN (id of an earlier run whose checkpoints to continue from, must use the same settings),
#      INSTANCE_TYPE (default c7g.16xlarge, 64 Graviton vCPUs), MAX_HOURS (hard stop, default 4),
#      SPOT=0 for on-demand.
#      COMMAND: run this instead of the pipeline (from the code folder; write outputs to out/, which starts as a
#      copy of bench/ and is uploaded like pipeline checkpoints).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
SCALE="${SCALE:-4}"
PASSES="${PASSES:-2}"
AGENT="${AGENT:-heuristic}"
PIPELINE_ARGS="--agent $AGENT --scale $SCALE --passes $PASSES"
[ -n "${SETS_AGENT:-}" ] && PIPELINE_ARGS="$PIPELINE_ARGS --sets-agent $SETS_AGENT"
[ -n "${MATCHUPS_AGENT:-}" ] && PIPELINE_ARGS="$PIPELINE_ARGS --matchups-agent $MATCHUPS_AGENT"
[ -n "${LADDER_AGENT:-}" ] && PIPELINE_ARGS="$PIPELINE_ARGS --ladder-agent $LADDER_AGENT"
[ -n "${MATCHUP_K:-}" ] && PIPELINE_ARGS="$PIPELINE_ARGS --matchup-k $MATCHUP_K"
[ -n "${LADDER_GAMES:-}" ] && PIPELINE_ARGS="$PIPELINE_ARGS --ladder-games $LADDER_GAMES"
RESUME_RUN="${RESUME_RUN:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-c7g.16xlarge}"
MAX_HOURS="${MAX_HOURS:-4}"
RUN_ID="$(date -u +%Y%m%d-%H%M%S)"
PREFIX="runs/$RUN_ID"

case "$INSTANCE_TYPE" in
	*g.*|*gd.*|*gn.*) ARCH=arm64 ;;
	*) ARCH=x86_64 ;;
esac
AMI="$(aws ec2 describe-images --region "$REGION" --owners amazon \
	--filters "Name=name,Values=al2023-ami-2023*-kernel-*-$ARCH" "Name=state,Values=available" \
	--query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
NODE_ARCH=$([ "$ARCH" = arm64 ] && echo arm64 || echo x64)
NODE_VERSION="${NODE_VERSION:-v22.23.4}"

echo "Run $RUN_ID: $INSTANCE_TYPE ($ARCH, $AMI) command=${COMMAND:-pipeline $PIPELINE_ARGS} resume=${RESUME_RUN:-no} -> s3://$BUCKET/$PREFIX/"

TMP="$(mktemp -d)"
EXTRA=()
[ -d bench ] && EXTRA+=(bench)
[ -f web/data/results.json ] && EXTRA+=(web/data/results.json)
tar czf "$TMP/code.tgz" package.json package-lock.json sim vendor "${EXTRA[@]}"
COMMAND="${COMMAND:-node --max-old-space-size=40000 sim/pipeline.js $PIPELINE_ARGS --out out --web out/results.json}"
aws s3 cp --quiet "$TMP/code.tgz" "s3://$BUCKET/$PREFIX/code.tgz"

cat > "$TMP/userdata.sh" <<EOF
#!/bin/bash
set -uxo pipefail
# hard stop no matter what happens below
shutdown -h +$((MAX_HOURS * 60))
exec > >(tee /var/log/champions-sim.log) 2>&1
upload_log() { aws s3 cp /var/log/champions-sim.log s3://$BUCKET/$PREFIX/run.log --region $REGION || true; }
trap 'upload_log; shutdown -h now' EXIT
# 64 V8 isolates in one process can exceed Linux's default per-process memory-mapping cap (65530), which
# surfaces as bogus "heap out of memory" crashes; raise it well above what the workers need.
sysctl -w vm.max_map_count=4194304
mkdir -p /opt/sim && cd /opt/sim
curl -sSfLO https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz
curl -sSfL https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt | grep "node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" | sha256sum -c
tar xJf node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz
export PATH=/opt/sim/node-$NODE_VERSION-linux-$NODE_ARCH/bin:\$PATH
aws s3 cp s3://$BUCKET/$PREFIX/code.tgz . --region $REGION
tar xzf code.tgz
npm ci --omit=dev --no-audit --no-fund
mkdir -p out
[ -d bench ] && cp -r bench/. out/
[ -n "$RESUME_RUN" ] && aws s3 sync s3://$BUCKET/runs/$RESUME_RUN/out out --region $REGION
echo "running" | aws s3 cp - s3://$BUCKET/$PREFIX/status --region $REGION
# upload checkpoints every 5 minutes so a Spot interruption doesn't lose everything
( while sleep 300; do
	# diagnostics (never allowed to break the checkpoint loop): memory mappings and memory use of the pipeline
	( P=\$(pgrep -f "sim/(pipeline|bench).js" | head -1); echo "[diag] maps=\$(wc -l < /proc/\$P/maps) rssKB=\$(awk '/VmRSS/{print \$2}' /proc/\$P/status) used=\$(free -m | awk '/Mem:/{print \$3}')MB" ) 2>/dev/null || true
	aws s3 sync out s3://$BUCKET/$PREFIX/out --region $REGION --quiet; upload_log
done ) &
if $COMMAND; then
	aws s3 sync out s3://$BUCKET/$PREFIX/out --region $REGION
	echo "done" | aws s3 cp - s3://$BUCKET/$PREFIX/status --region $REGION
else
	echo "failed" | aws s3 cp - s3://$BUCKET/$PREFIX/status --region $REGION
fi
EOF

MARKET=()
if [ "${SPOT:-1}" = 1 ]; then
	MARKET=(--instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}')
fi

INSTANCE_ID="$(aws ec2 run-instances --region "$REGION" \
	--image-id "$AMI" --instance-type "$INSTANCE_TYPE" --count 1 \
	--iam-instance-profile Name=champions-sim \
	--instance-initiated-shutdown-behavior terminate \
	--metadata-options HttpTokens=required \
	"${MARKET[@]}" \
	--user-data "file://$TMP/userdata.sh" \
	--tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=champions-sim-$RUN_ID},{Key=project,Value=champions-sim}]" \
	--query 'Instances[0].InstanceId' --output text)"
rm -rf "$TMP"

echo "$RUN_ID" > aws/.last-run
echo "Launched $INSTANCE_ID. Check progress with: aws/status.sh   Fetch results with: aws/fetch.sh"
