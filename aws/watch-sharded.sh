#!/usr/bin/env bash
# Watch a sharded run (aws/launch-sharded.sh) and print one line per event worth acting on: a stage handoff in the
# shared folder, a machine that stopped or failed, memory above WARN_GB, errors in a log, and the final results.
# Exits when shared/results.json exists or every machine has stopped. Polls every POLL seconds (default 120).
set -uo pipefail
cd "$(dirname "$0")/.."
REGION="${AWS_REGION:-us-east-1}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
GROUP="${1:-$(cat aws/.last-sharded)}"
WARN_GB="${WARN_GB:-100}"
POLL="${POLL:-120}"
SHARED="s3://$BUCKET/runs/$GROUP/shared"
declare -A seen_err last_state
prev_shared=""
while true; do
	shared="$(aws s3 ls "$SHARED/" --recursive --region "$REGION" 2>/dev/null | awk '{print $4}' | sed "s|runs/$GROUP/shared/||" | sort | tr '\n' ' ')"
	if [ "$shared" != "$prev_shared" ]; then
		new="$(comm -13 <(tr ' ' '\n' <<<"$prev_shared" | sort) <(tr ' ' '\n' <<<"$shared" | sort) | tr '\n' ' ')"
		[ -n "${new// }" ] && echo "$(date -u +%H:%M) shared: new $new"
		prev_shared="$shared"
	fi
	if grep -qw "results.json" <<<"$shared"; then echo "$(date -u +%H:%M) DONE: $SHARED/results.json"; exit 0; fi
	stopped=0; total=0
	while read -r k RUN; do
		total=$((total + 1))
		state="$(aws ec2 describe-instances --region "$REGION" --filters "Name=tag:Name,Values=champions-sim-$RUN" \
			--query 'Reservations[].Instances[].State.Name' --output text 2>/dev/null | tr '\t' ' ')"
		status="$(aws s3 cp "s3://$BUCKET/runs/$RUN/status" - --region "$REGION" 2>/dev/null)"
		key="$state/$status"
		if [ "${last_state[$k]:-}" != "$key" ]; then
			[ -n "${last_state[$k]:-}" ] && echo "$(date -u +%H:%M) shard $k: machine ${state:-gone}, status ${status:-?}"
			last_state[$k]="$key"
		fi
		[[ "$state" != *running* ]] && stopped=$((stopped + 1))
		log="$(aws s3 cp "s3://$BUCKET/runs/$RUN/run.log" - --region "$REGION" 2>/dev/null)"
		rss="$(grep -o 'rss=[0-9]*MB' <<<"$log" | tail -1 | tr -dc 0-9)"
		[ -n "$rss" ] && [ "$rss" -gt $((WARN_GB * 1024)) ] && echo "$(date -u +%H:%M) shard $k: MEMORY rss=${rss}MB"
		errs="$(grep -E 'Error|exited with|FATAL|heap out of memory|failures=[1-9]' <<<"$log" | tail -3)"
		h="$(md5sum <<<"$errs" | cut -c1-8)"
		if [ -n "$errs" ] && [ "${seen_err[$k]:-}" != "$h" ]; then echo "$(date -u +%H:%M) shard $k: ERRORS: $(tr '\n' ' ' <<<"$errs" | cut -c1-300)"; seen_err[$k]="$h"; fi
	done < <(awk '$1 == "shard" {r[$2] = $3} END {for (k in r) print k, r[k]}' "aws/.sharded-$GROUP" | sort -n)
	if [ "$total" -gt 0 ] && [ "$stopped" -eq "$total" ]; then echo "$(date -u +%H:%M) ALL MACHINES STOPPED without shared/results.json"; exit 1; fi
	sleep "$POLL"
done
