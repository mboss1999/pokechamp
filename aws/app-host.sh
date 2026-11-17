#!/usr/bin/env bash
# Launch the always-on app host: a small EC2 instance in us-east-1 that serves the team builder (web/serve.cjs) to
# your devices over Tailscale (a private network: nothing is open to the internet). Battles run on AWS Lambda
# (APP_POOL=lambda) and EC2 tuning machines, never on the host itself.
#
#   aws/app-iam.sh      once, in AWS CloudShell (creates the pokechamp-app role this host uses)
#   aws/app-host.sh     launch; then open the Tailscale login link it prints to add the host to your tailnet
#   aws/app-host.sh status | url
#
# The host has no SSH key and accepts no inbound connections (Tailscale connects outward). It keeps itself current:
# every 5 minutes it fetches BRANCH and, when it moved, pulls, reinstalls and restarts the app, so pushing to the
# branch is how results and code reach it. Status and the Tailscale login link are read from its console log.
#
# Env: INSTANCE_TYPE (t4g.small), BRANCH (the git branch the host follows; default: this checkout's).
set -euo pipefail
cd "$(dirname "$0")/.."
REGION=us-east-1
NAME=pokechamp-app
REPO=https://github.com/mboss1999/pokechamp.git
BRANCH="${BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
id_of() { aws ec2 describe-instances --region $REGION --filters "Name=tag:Name,Values=$NAME" "Name=instance-state-name,Values=pending,running,stopping,stopped" \
	--query 'Reservations[].Instances[].InstanceId' --output text; }
ip_of() { aws ec2 describe-instances --region $REGION --instance-ids "$1" --query 'Reservations[].Instances[].PublicIpAddress' --output text; }

console() { aws ec2 get-console-output --region $REGION --instance-id "$1" --latest --output text 2>/dev/null; }
case "${1:-launch}" in
status)
	ID="$(id_of)"; [ -z "$ID" ] && { echo "no $NAME instance"; exit 0; }
	echo "$ID $(aws ec2 describe-instances --region $REGION --instance-ids "$ID" --query 'Reservations[].Instances[].State.Name' --output text)"
	console "$ID" | grep -E "pokechamp-setup|pokechamp-update|TAILSCALE" | tail -8
	exit 0 ;;
url)
	ID="$(id_of)"; [ -z "$ID" ] && { echo "no $NAME instance"; exit 1; }
	console "$ID" | grep -o 'https://login.tailscale.com/[^ ]*' | tail -1
	console "$ID" | grep -oE 'APP URL: .*' | tail -1
	exit 0 ;;
esac

[ -n "$(id_of)" ] && { echo "$NAME already exists: $(id_of) (aws/app-host.sh status)"; exit 1; }
VPC="$(aws ec2 describe-vpcs --region $REGION --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
SG="$(aws ec2 describe-security-groups --region $REGION --filters Name=group-name,Values=default Name=vpc-id,Values=$VPC --query 'SecurityGroups[0].GroupId' --output text)"
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
cat > /usr/local/bin/pokechamp-update <<'UPD'
#!/bin/bash
# follow the branch: pull, reinstall and restart when it moved
cd /home/pokechamp/pokechamp || exit 0
before=\$(sudo -u pokechamp git rev-parse HEAD)
sudo -u pokechamp git fetch -q origin $BRANCH || exit 0
after=\$(sudo -u pokechamp git rev-parse origin/$BRANCH)
[ "\$before" = "\$after" ] && exit 0
sudo -u pokechamp git reset -q --hard origin/$BRANCH
sudo -u pokechamp bash -lc 'cd ~/pokechamp && PATH=/opt/node/bin:\$PATH npm ci --omit=dev --silent'
systemctl restart pokechamp-app
echo "pokechamp-update: \$before -> \$after" | tee /dev/console
UPD
chmod +x /usr/local/bin/pokechamp-update
cat > /etc/systemd/system/pokechamp-update.service <<'UNIT'
[Unit]
Description=Follow the pokechamp branch
[Service]
Type=oneshot
ExecStart=/usr/local/bin/pokechamp-update
UNIT
cat > /etc/systemd/system/pokechamp-update.timer <<'UNIT'
[Unit]
Description=Follow the pokechamp branch every 5 minutes
[Timer]
OnBootSec=5min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now pokechamp-update.timer
curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled
# prints a login link (also to the console log); waits until the host is approved
(tailscale up --ssh --hostname=pokechamp > /var/log/tailscale-up.log 2>&1 &)
for i in \$(seq 1 30); do grep -o 'https://login.tailscale.com/[^ ]*' /var/log/tailscale-up.log && break; sleep 2; done | head -1 | sed 's/^/TAILSCALE LOGIN: /' > /dev/console || true
until tailscale status >/dev/null 2>&1; do sleep 5; done
if tailscale serve --bg --https=443 http://127.0.0.1:5173; then
	echo "APP URL: https://\$(tailscale status --json | python3 -c 'import json,sys; print(json.load(sys.stdin)["Self"]["DNSName"].rstrip("."))')" > /dev/console
else
	tailscale serve --bg --http=80 http://127.0.0.1:5173
	echo "APP URL: http://pokechamp (or http://\$(tailscale ip -4))" > /dev/console
fi
echo "pokechamp app host ready" > /dev/console
EOF
)"
ID="$(aws ec2 run-instances --region $REGION --image-id "$AMI" --instance-type "${INSTANCE_TYPE:-t4g.small}" \
	--security-group-ids "$SG" --iam-instance-profile Name=pokechamp-app \
	--block-device-mappings 'DeviceName=/dev/xvda,Ebs={VolumeSize=20,VolumeType=gp3,DeleteOnTermination=true}' \
	--metadata-options HttpTokens=required \
	--tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME},{Key=project,Value=champions-sim}]" \
	--user-data "$USERDATA" --query 'Instances[0].InstanceId' --output text)"
echo "launched $ID ($NAME, following branch $BRANCH). In ~3 minutes: aws/app-host.sh url  -> open the Tailscale login link"
