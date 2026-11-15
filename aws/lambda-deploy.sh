#!/usr/bin/env bash
# Create or update the Lambda function that plays battles for the app (sim/lambda.js, called by
# sim/lambdapool.js). Safe to re-run; run again after changing anything under sim/ or the simulator.
#
# Needs the permissions in aws/lambda-policy.json. Env: FUNCTION (default champions-sim-battles),
# MEMORY_MB (default 1769, exactly one full vCPU; a battle is single-threaded), TIMEOUT_S (default 120).
set -euo pipefail
cd "$(dirname "$0")/.."

REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
FUNCTION="${FUNCTION:-champions-sim-battles}"
ROLE=champions-sim-lambda
MEMORY_MB="${MEMORY_MB:-1769}"
TIMEOUT_S="${TIMEOUT_S:-120}"

if ! ROLE_ARN="$(aws iam get-role --role-name "$ROLE" --query Role.Arn --output text 2>/dev/null)"; then
	ROLE_ARN="$(aws iam create-role --role-name "$ROLE" --query Role.Arn --output text --assume-role-policy-document '{
		"Version": "2012-10-17",
		"Statement": [{"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"}, "Action": "sts:AssumeRole"}]
	}')"
	aws iam attach-role-policy --role-name "$ROLE" \
		--policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
	echo "Created role $ROLE; waiting for IAM to propagate…"
	sleep 12
fi

# Package: the sim code, the simulator (copied, not the node_modules symlink) and the results the analysis
# engine reads. The AWS SDK is not needed inside Lambda.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/pkg/node_modules" "$TMP/pkg/web/data"
cp -R sim "$TMP/pkg/sim"
cp -RL vendor/pokemon-showdown "$TMP/pkg/node_modules/pokemon-showdown"
# and the simulator's own runtime dependencies (package.json "dependencies"; just ts-chacha20 today)
for dep in $(node_bin=$(command -v node || echo .tools/node/bin/node); "$node_bin" -p \
	"Object.keys(require('./vendor/pokemon-showdown/package.json').dependencies || {}).join(' ')"); do
	cp -RL "node_modules/$dep" "$TMP/pkg/node_modules/$dep"
done
cp web/data/results.json "$TMP/pkg/web/data/"
echo '{"private": true}' > "$TMP/pkg/package.json"
# fail here, not inside Lambda, if anything a battle needs is missing from the package
(cd "$TMP/pkg" && "$(command -v node || echo "$OLDPWD/.tools/node/bin/node")" -e "require('./sim/lambda'); require('./sim/battle')")
(cd "$TMP/pkg" && zip -qr "$TMP/fn.zip" .)
echo "Package: $(du -h "$TMP/fn.zip" | cut -f1)"

if aws lambda get-function --function-name "$FUNCTION" --region "$REGION" >/dev/null 2>&1; then
	aws lambda update-function-code --function-name "$FUNCTION" --region "$REGION" \
		--zip-file "fileb://$TMP/fn.zip" --architectures arm64 >/dev/null
	aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
	aws lambda update-function-configuration --function-name "$FUNCTION" --region "$REGION" \
		--memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" >/dev/null
	aws lambda wait function-updated --function-name "$FUNCTION" --region "$REGION"
	echo "Updated $FUNCTION"
else
	for i in 1 2 3 4 5; do
		# a just-created role can take a little longer than the sleep above to become usable by Lambda
		if aws lambda create-function --function-name "$FUNCTION" --region "$REGION" \
			--runtime nodejs22.x --architectures arm64 --handler sim/lambda.handler \
			--role "$ROLE_ARN" --memory-size "$MEMORY_MB" --timeout "$TIMEOUT_S" \
			--tags project=champions-sim \
			--zip-file "fileb://$TMP/fn.zip" >/dev/null; then break; fi
		[ "$i" = 5 ] && exit 1
		sleep 8
	done
	aws lambda wait function-active-v2 --function-name "$FUNCTION" --region "$REGION"
	echo "Created $FUNCTION"
fi
echo "Lambda concurrency limit: $(aws lambda get-account-settings --region "$REGION" --query AccountLimit.ConcurrentExecutions --output text 2>/dev/null || echo unknown)"
