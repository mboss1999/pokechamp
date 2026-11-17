#!/usr/bin/env bash
# One-time IAM setup for the always-on app host (aws/app-host.sh). Run it once in AWS CloudShell (the terminal
# icon in the AWS console, signed in as an account admin): it needs IAM permissions the sim machines don't have.
#
# Creates the role pokechamp-app (instance profile of the same name) with only what the app's server does:
#   - invoke the battle Lambda functions (champions-sim-*)
#   - read and write the simulation bucket (tuning batches stream results through it)
#   - launch EC2 Spot tuning machines with the existing champions-sim role (aws/launch.sh), tag and describe them
# and lets the Claude session host's role (EC2FullAccessS3) pass pokechamp-app to the instance it launches.
set -euo pipefail
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGION=us-east-1
BUCKET="champions-sim-$ACCOUNT"
ROLE=pokechamp-app

if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
	aws iam create-role --role-name "$ROLE" --description "Pokechamp team builder app host" --assume-role-policy-document '{
		"Version": "2012-10-17",
		"Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]
	}' >/dev/null
	echo "created role $ROLE"
fi
aws iam put-role-policy --role-name "$ROLE" --policy-name pokechamp-app --policy-document "{
	\"Version\": \"2012-10-17\",
	\"Statement\": [
		{\"Effect\": \"Allow\", \"Action\": [\"lambda:InvokeFunction\", \"lambda:GetFunction\", \"lambda:GetFunctionConfiguration\"],
		 \"Resource\": \"arn:aws:lambda:$REGION:$ACCOUNT:function:champions-sim-*\"},
		{\"Effect\": \"Allow\", \"Action\": \"lambda:GetAccountSettings\", \"Resource\": \"*\"},
		{\"Effect\": \"Allow\", \"Action\": [\"s3:GetObject\", \"s3:PutObject\", \"s3:DeleteObject\"], \"Resource\": \"arn:aws:s3:::$BUCKET/*\"},
		{\"Effect\": \"Allow\", \"Action\": \"s3:ListBucket\", \"Resource\": \"arn:aws:s3:::$BUCKET\"},
		{\"Effect\": \"Allow\", \"Action\": [\"ec2:RunInstances\", \"ec2:CreateTags\", \"ec2:DescribeInstances\", \"ec2:DescribeImages\",
		 \"ec2:DescribeSpotInstanceRequests\"], \"Resource\": \"*\", \"Condition\": {\"StringEquals\": {\"aws:RequestedRegion\": \"$REGION\"}}},
		{\"Effect\": \"Allow\", \"Action\": \"iam:PassRole\", \"Resource\": \"arn:aws:iam::$ACCOUNT:role/champions-sim\"}
	]
}"
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
	aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
	aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
	echo "created instance profile $ROLE"
fi
# the Claude session host launches the app instance with this profile
aws iam put-role-policy --role-name EC2FullAccessS3 --policy-name pokechamp-app-pass --policy-document "{
	\"Version\": \"2012-10-17\",
	\"Statement\": [{\"Effect\": \"Allow\", \"Action\": \"iam:PassRole\", \"Resource\": \"arn:aws:iam::$ACCOUNT:role/$ROLE\"}]
}"
echo "done: role and instance profile $ROLE ready"
