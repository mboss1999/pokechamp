#!/usr/bin/env bash
# Run the whole pipeline split over several EC2 Spot machines (default 4), each running sim/shard.js on its share
# of the roster. The machines swap results through s3://<bucket>/runs/<group>/shared between stages (set
# search pass 1, pass 2, then matchup and ladder battles); shard 0 writes the final results.json there.
#
#   aws/launch-sharded.sh                                  # new run, settings below
#   GROUP=<group> ONLY="2" aws/launch-sharded.sh           # relaunch shard 2 after a Spot interruption; it
#                                                          # resumes from its checkpoints and finished phases
#   aws/status-sharded.sh [group]                          # progress of every shard
#
# Env: SHARDS (4), SCALE (4), MATCHUPS_AGENT / LADDER_AGENT (rollout4all), MATCHUP_K (16), LADDER_GAMES (60000),
#      MAX_HOURS per machine (20), INSTANCE_TYPE (c7g.16xlarge), EXTRA_ARGS (more sim/pipeline.js options),
#      WORKER_HEAP_MB (600 per worker thread) / MAIN_HEAP_MB (16000) / CONCURRENCY (16 entries in flight): the first
#      run with 1 GB workers, a 40 GB main heap and 32 entries in flight used ~122 of 128 GB and hung all 4 machines.
#      MALLOC_ARENA_MAX (2): with 600 MB heaps a rerun still reached ~90 GB within 5 minutes, which points at glibc's
#      per-thread malloc arenas (up to 8 per core) fragmenting across 64 worker threads, not at the JS heaps.
#      FORMAT (unset = singles; gen9championsvgc2026regmc = doubles: doubles pilot for every stage, no strong-pilot
#      checks, starting sets from web/data/doubles-results.json if there is one).
# Starting sets and rating weights come from the current web/data/results.json (doubles: doubles-results.json).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
SHARDS="${SHARDS:-4}"
NEW_GROUP=0
if [ -z "${GROUP:-}" ]; then GROUP="$(date -u +%Y%m%d-%H%M%S)-sharded"; NEW_GROUP=1; fi
STATE="aws/.sharded-$GROUP"
SHARED="s3://$BUCKET/runs/$GROUP/shared"
if [ -n "${FORMAT:-}" ] && [[ "$FORMAT" == *vgc* || "$FORMAT" == *doubles* ]]; then
	STRONG=dheuristic; INIT=web/data/doubles-results.json; FORMAT_ENV="FORMAT=$FORMAT"
else
	STRONG=rollout4all; INIT=web/data/results.json; FORMAT_ENV="${FORMAT:+FORMAT=$FORMAT}"
fi
ARGS="--scale ${SCALE:-4} --matchups-agent ${MATCHUPS_AGENT:-$STRONG} --ladder-agent ${LADDER_AGENT:-$STRONG}"
ARGS="$ARGS --matchup-k ${MATCHUP_K:-16} --ladder-games ${LADDER_GAMES:-60000}"
[ -f "$INIT" ] && ARGS="$ARGS --init-sets $INIT --weights $INIT"
ARGS="$ARGS ${EXTRA_ARGS:-}"
[ "$NEW_GROUP" = 1 ] && echo "shards=$SHARDS args=$ARGS" > "$STATE"

for k in $(seq 0 $((SHARDS - 1))); do
	if [ -n "${ONLY:-}" ] && [[ " $ONLY " != *" $k "* ]]; then continue; fi
	PREV="$(awk -v k="$k" '$1 == "shard" && $2 == k {r = $3} END {print r}' "$STATE")"
	RUN="$GROUP-s$k-$(date -u +%H%M%S)"
	echo "== shard $k/$SHARDS: run $RUN${PREV:+ (resuming $PREV)}"
	RUN_ID="$RUN" RESUME_RUN="$PREV" KEEP_LAST_RUN=1 MAX_HOURS="${MAX_HOURS:-20}" \
		COMMAND="env $FORMAT_ENV MALLOC_ARENA_MAX=${MALLOC_ARENA_MAX:-2} WORKER_HEAP_MB=${WORKER_HEAP_MB:-600} MAIN_HEAP_MB=${MAIN_HEAP_MB:-16000} node sim/shard.js --shard $k/$SHARDS --shared $SHARED $ARGS --concurrency ${CONCURRENCY:-16} --out out" aws/launch.sh
	echo "shard $k $RUN" >> "$STATE"
	sleep 1
done
echo "$GROUP" > aws/.last-sharded
echo "Group $GROUP. Progress: aws/status-sharded.sh   Results appear at $SHARED/results.json"
