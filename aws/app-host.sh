#!/usr/bin/env bash
# Launch the always-on app host: a small EC2 instance in us-east-1 that serves the team builder (web/serve.cjs) to
# your devices over Tailscale (a private network: nothing is open to the internet). Battles run on AWS Lambda
# (APP_POOL=lambda) and EC2 tuning machines, never on the host itself.
#
#   aws/app-iam.sh      once, in AWS CloudShell (creates the pokechamp-app role this host uses)
#   aws/app-host.sh     launch; then open the Tailscale login link it prints to add the host to your tailnet
#   aws/app-host.sh status | url | update
#
# Env: INSTANCE_TYPE (t4g.small), BRANCH (the git branch the host runs; default: this checkout's), SSH_FROM (CIDR
# allowed to SSH for maintenance; default: this machine's public IP).
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=us-east-1
NAME=pokechamp-app
REPO=https://github.com/mboss1999/pokechamp.git
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
KEY="$HOME/.ssh/pokechamp-app.pem"
id_of() { aws ec2 describe-instances --region $REGION --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
	--query 'Reservations[].Instances[].InstanceId' --output text; }
ip_of() { aws ec2 describe-instances --region $REGION --instance-ids "$1" --query 'Reservations[].Instances[].PublicIpAddress' --output text; }

case "${1:-launch}" in
status)
	ID="$(id_of)"; [ -z "$ID" ] && { echo "no $NAME instance"; exit 0; }
	echo "$ID $(aws ec2 describe-instances --region $REGION --instance-ids "$ID" --query 'Reservations[].Instances[].State.Name' --output text) $(ip_of "$ID")"
	ssh -o StrictHostKeyChecking=accept-new -i "$KEY" "ec2-user@$(ip_of "$ID")" \
		'systemctl is-active pokechamp-app; sudo tailscale status --self --peers=false 2>&1 | head -2; tail -3 /var/log/pokechamp-setup.log' || true
	exit 0 ;;
url)
	ID="$(id_of)"
	aws ec2 get-console-output --region $REGION --instance-id "$ID" --latest --output text | grep -o 'https://login.tailscale.com/[^ ]*' | tail -1
	ssh -o StrictHostKeyChecking=accept-new -i "$KEY" "ec2-user@$(ip_of "$ID")" 'grep -o "https://login.tailscale.com/[^ ]*" /var/log/tailscale-up.log | tail -1; sudo tailscale serve status 2>/dev/null' || true
	exit 0 ;;
update)
	# pull the branch and restart the app (results, code)
	ID="$(id_of)"
	ssh -o StrictHostKeyChecking=accept-new -i "$KEY" "ec2-user@$(ip_of "$ID")" \
		"sudo -u pokechamp bash -lc 'cd ~/pokechamp && git fetch -q origin $BRANCH && git checkout -q $BRANCH && git reset -q --hard origin/$BRANCH && PATH=/opt/node/bin:\$PATH npm ci --omit=dev --silent' && sudo systemctl restart pokechamp-app && systemctl is-active pokechamp-app"
	exit 0 ;;
esac

[ -n "$(id_of)" ] && { echo "$NAME already exists: $(id_of) (aws/app-host.sh status)"; exit 1; }
SSH_FROM="${SSH_FROM:-$(curl -s -m 10 https://checkip.amazonaws.com | tr -d '\n')/32}"
if [ ! -f "$KEY" ]; then
	mkdir -p "$(dirname "$KEY")"
	aws ec2 create-key-pair --region $REGION --key-name $NAME --query KeyMaterial --output text > "$KEY"
	chmod 600 "$KEY"
fi
VPC="$(aws ec2 describe-vpcs --region $REGION --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$(aws ec2 describe-security-groups --region $REGION --filters Name=group-name,Values=$NAME Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)"
if [ "$SG" = "None" ]; then
	SG="$(aws ec2 create-security-group --region $REGION --group-name $NAME --vpc-id "$VPC" --description "pokechamp app host: SSH from the session host only; app reached over Tailscale" --query GroupId --output text)"
	aws ec2 authorize-security-group-ingress --region $REGION --group-id "$SG" --protocol tcp --port 22 --cidr "$SSH_FROM" >/dev/null
fi
AMI="$(aws ec2 describe-images --region $REGION --owners amazon --filters "Name=name,Values=al2023-ami-2023*-kernel-*-arm64" "Name=state,Values=available" \
	--query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"
NODE_VERSION=v22.23.4
USERDATA="$(cat <<EOF
#!/bin/bash
exec > >(tee -a /var/log/pokechamp-setup.log | logger -t pokechamp-setup -s 2>/dev/console) 2>&1
set -euxo pipefail
dnf install -y git tar xz
curl -fsSL https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-arm64.tar.xz | tar -xJ -C /opt
ln -sfn /opt/node-$NODE_VERSION-linux-arm64 /opt/node
useradd -m pokechamp || true
sudo -u pokechamp git clone -q -b $BRANCH $REPO /home/pokechamp/pokechamp
sudo -u pokechamp bash -lc 'cd ~/pokechamp && PATH=/opt/node/bin:\$PATH npm ci --omit=dev --silent'
cat > /etc/systemd/system/pokechamp-app.service <<'UNIT'
[Unit]
Description=Pokechamp team builder (web/serve.cjs)
After=network-online.target
[Service]
User=pokechamp
WorkingDirectory=/home/pokechamp/pokechamp
Environment=AWS_REGION=$REGION
Environment=AWS_DEFAULT_REGION=$REGION
Environment=APP_POOL=lambda
Environment=PATH=/opt/node/bin:/usr/local/bin:/usr/bin:/bin
ExecStart=/opt/node/bin/node web/serve.cjs 5173
Restart=always
RestartSec=5
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now pokechamp-app
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
# prints a login link (also to the console log); waits until the host is approved
(tailscale up --ssh --hostname=pokechamp > /var/log/tailscale-up.log 2>&1 &)
for i in \$(seq 1 30); do grep -o 'https://login.tailscale.com/[^ ]*' /var/log/tailscale-up.log && break; sleep 2; done | head -1 | sed 's/^/TAILSCALE LOGIN: /' > /dev/console || true
until tailscale status >/dev/null 2>&1; do sleep 5; done
tailscale serve --bg --https=443 http://127.0.0.1:5173 || tailscale serve --bg --http=80 http://127.0.0.1:5173
echo "pokechamp app host ready"
EOF
)"
ID="$(aws ec2 run-instances --region $REGION --image-id "$AMI" --instance-type "${INSTANCE_TYPE:-t4g.small}" --key-name $NAME \
	--security-group-ids "$SG" --iam-instance-profile Name=pokechamp-app \
	--block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
	--metadata-options HttpTokens=required \
	--tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=champions-sim}]" \
	--user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)"
echo "launched $ID ($NAME, branch $BRANCH). In ~3 minutes: aws/app-host.sh url  -> open the Tailscale login link"
