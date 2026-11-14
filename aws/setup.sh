#!/usr/bin/env bash
# One-time AWS setup: an S3 bucket for code + results, and an instance role that
# can only read/write that bucket. Safe to re-run.
set -euo pipefail

REGION="${AWS_REGION:-$(aws configure get region || echo us-east-1)}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="${BUCKET:-champions-sim-$ACCOUNT}"
ROLE=champions-sim

echo "Region: $REGION  Bucket: $BUCKET  Role: $ROLE"

if ! aws s3api head-bucket --bucket "$BUCKET" 2>/dev/null; then
	if [ "$REGION" = us-east-1 ]; then
		aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" >/dev/null
	else
		aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
			--create-bucket-configuration LocationConstraint="$REGION" >/dev/null
	fi
	aws s3api put-public-access-block --bucket "$BUCKET" --public-access-block-configuration \
		BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
	echo "Created bucket $BUCKET"
fi

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
	aws iam create-role --role-name "$ROLE" --assume-role-policy-document '{
		"Version": "2012-10-17",
		"Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]
	}' >/dev/null
	echo "Created role $ROLE"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name s3-bucket-only --policy-document "{
	\"Version\": \"2012-10-17\",
	\"Statement\": [
		{\"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\"], \"Resource\": \"arn:aws:s3:::$BUCKET/*\"},
		{\"Effect\": \"Allow\", \"Action\": [\"s3:ListBucket\"], \"Resource\": \"arn:aws:s3:::$BUCKET\"}
	]
}"

if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
	aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
	aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
	echo "Created instance profile $ROLE (IAM can take ~10s to propagate)"
fi
echo "Setup complete."
