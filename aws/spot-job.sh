#!/usr/bin/env bash
# Long simulation jobs on one EC2 Spot box (about 8x cheaper per vCPU-hour than Lambda), surviving Spot reclaims.
#
#   aws/spot-job.sh start NAME 'COMMAND'    launch (tries INSTANCE_TYPES in order until one has Spot capacity)
#   aws/spot-job.sh watch NAME              babysit: after a reclaim, relaunch resuming from the last run's out/;
#                                           exits 0 when the job is done, 1 if it failed or hit a cap
#   aws/spot-job.sh status NAME             runs so far, state and log tail
#   aws/spot-job.sh fetch NAME DEST         download the finished job's out/ to DEST
#
# COMMAND runs from the code folder (see aws/launch.sh COMMAND). Make it resumable: write outputs under out/ and pass
# --checkpoint out/NAME.ckpt (sim/checkpoint.js) to the sim script, so a relaunch replays finished battles from the
# checkpoint instead of playing them again. out/ is uploaded every 5 minutes, so a reclaim loses at most ~5 minutes.
#
# Env: EXTRA_FILES (inputs to ship, as in aws/launch.sh; web/data/results.json always goes), MAX_HOURS (per box,
#      default 8), INSTANCE_TYPES (default c7g.16xlarge c8g.16xlarge m8g.16xlarge c7gn.16xlarge m7g.16xlarge),
#      MAX_LAUNCHES (default 20) and MAX_BOX_HOURS (all boxes together, default 24) cap a runaway job.
# Job state lives in s3://BUCKET/jobs/NAME/ (command, extra files, run ids), so any machine can watch it.
set -euo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
export AWS_REGION="$REGION"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
TYPES="${INSTANCE_TYPES:-c7g.16xlarge c8g.16xlarge m8g.16xlarge c7gn.16xlarge m7g.16xlarge}"
ACTION="${1:?usage: aws/spot-job.sh start|watch|status|fetch NAME ...}"
NAME="${2:?job name}"
J="s3://$BUCKET/jobs/$NAME"

get() { aws s3 cp --quiet "$J/$1" - 2>/dev/null || true; }
put() { aws s3 cp --quiet - "$J/$1"; }
last_run() { get runs | tail -n 1; }
# the latest run whose out/ reached S3 (a box reclaimed before its first upload has none): the one to resume from
resume_from() {
	local id
	for id in $(get runs | tac); do
		[ -n "$(aws s3 ls "s3://$BUCKET/runs/$id/out/" 2>/dev/null | head -1)" ] && { echo "$id"; return; }
	done
}
run_state() { aws s3 cp --quiet "s3://$BUCKET/runs/$1/status" - 2>/dev/null || echo starting; }
instance_state() {
	aws ec2 describe-instances --filters "Name=tag:Name,Values=champions-sim-$1" \
		--query 'Reservations[].Instances[].State.Name' --output text 2>/dev/null | awk '{print $NF}'
}

# launch one box, resuming from $1 (a run id) if given; prints the new run id
launch() {
	local resume="$1" cmd extra out t
	cmd="$(get command)"; extra="$(get extra)"
	for t in $TYPES; do
		out="$(RESUME_RUN="$resume" COMMAND="$cmd" EXTRA_FILES="$extra" INSTANCE_TYPE="$t" MAX_HOURS="${MAX_HOURS:-8}" \
			KEEP_LAST_RUN=1 bash aws/launch.sh 2>&1)" || true
		if grep -q '^Launched' <<<"$out"; then
			local id; id="$(sed -n 's/^Run \([0-9-]*\):.*/\1/p' <<<"$out" | head -1)"
			{ get runs; echo "$id"; } | sed '/^$/d' | put runs
			echo "$(date -u +%FT%TZ) launched $id on $t${resume:+ (resuming $resume)}" >&2
			echo "$id"; return 0
		fi
		echo "$(date -u +%FT%TZ) $t: $(grep -o 'InsufficientInstanceCapacity\|MaxSpotInstanceCountExceeded\|An error occurred.*' <<<"$out" | head -1)" >&2
	done
	return 1
}

box_hours() { # rough: launch to now (or to the last log upload) for every run of the job
	local total=0 id t0 t1
	for id in $(get runs); do
		t0="$(aws s3 ls "s3://$BUCKET/runs/$id/code.tgz" 2>/dev/null | awk '{print $1" "$2}')"
		t1="$(aws s3 ls "s3://$BUCKET/runs/$id/run.log" 2>/dev/null | awk '{print $1" "$2}')"
		[ -z "$t0" ] && continue
		[ -z "$t1" ] && t1="$(date -u '+%F %T')"
		total=$(( total + $(date -u -d "$t1" +%s) - $(date -u -d "$t0" +%s) ))
	done
	echo $(( total / 3600 ))
}

case "$ACTION" in
start)
	[ -n "$(get runs)" ] && { echo "job $NAME already exists (aws/spot-job.sh status $NAME)"; exit 1; }
	printf '%s' "${3:?COMMAND}" | put command
	printf '%s' "${EXTRA_FILES:-}" | put extra
	launch "" >/dev/null || { echo "no Spot capacity in: $TYPES"; exit 1; }
	;;
watch)
	launches=$(get runs | wc -l)
	while true; do
		id="$(last_run)"; st="$(run_state "$id")"
		case "$st" in
		done) echo "$(date -u +%FT%TZ) $NAME done (run $id)"; exit 0 ;;
		failed) echo "$(date -u +%FT%TZ) $NAME FAILED (run $id): aws/spot-job.sh status $NAME"; exit 1 ;;
		esac
		is="$(instance_state "$id")"
		if [ -z "$is" ] || [ "$is" = terminated ] || [ "$is" = shutting-down ] || [ "$is" = stopped ]; then
			if [ "$launches" -ge "${MAX_LAUNCHES:-20}" ]; then echo "$NAME: $launches launches, giving up"; exit 1; fi
			if [ "$(box_hours)" -ge "${MAX_BOX_HOURS:-24}" ]; then echo "$NAME: over ${MAX_BOX_HOURS:-24} box-hours, giving up"; exit 1; fi
			from="$(resume_from)"
			echo "$(date -u +%FT%TZ) run $id ended (${is:-no instance}, status $st): relaunching from ${from:-scratch}"
			until launch "$from" >/dev/null; do sleep 300; done
			launches=$((launches + 1))
		fi
		sleep 120
	done
	;;
status)
	echo "command: $(get command)"
	for id in $(get runs); do echo "  $id  $(instance_state "$id")  $(run_state "$id")"; done
	echo "box-hours so far: ~$(box_hours)"
	aws s3 cp --quiet "s3://$BUCKET/runs/$(last_run)/run.log" - 2>/dev/null | grep -v '^+' | tail -n 8 || true
	;;
fetch)
	aws s3 sync --quiet "s3://$BUCKET/runs/$(resume_from)/out" "${3:?DEST}"
	echo "fetched $(resume_from)/out to $3"
	;;
*) echo "unknown action $ACTION"; exit 1 ;;
esac
