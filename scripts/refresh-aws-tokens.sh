#!/usr/bin/env bash
# Mint short-lived AWS credentials for the Liadi agent container.
#
# The long-lived key belongs to IAM user `nanoclaw-broker`, whose only
# permission is sts:AssumeRole into the LiadiDevops role. This script assumes
# the role (1h session) and writes a standard AWS credentials file to a host
# directory that is bind-mounted read-only into Liadi's container. Run from a
# systemd user timer every 30 minutes so the container never holds an expired
# or long-lived credential.
set -euo pipefail

AWS=/home/ubuntu/.local/bin/aws
export AWS_SHARED_CREDENTIALS_FILE=/home/ubuntu/.nanoclaw-aws/credentials
OUT_DIR=/home/ubuntu/.nanoclaw-aws/liadi
ROLE_ARN=arn:aws:iam::109049466344:role/LiadiDevops
REGION=eu-central-1

mkdir -p "$OUT_DIR"
chmod 755 "$OUT_DIR"

"$AWS" sts assume-role \
  --profile broker \
  --role-arn "$ROLE_ARN" \
  --role-session-name liadi-devops \
  --duration-seconds 3600 \
  --output json |
python3 -c "
import json, os, sys
c = json.load(sys.stdin)['Credentials']
out_dir = '$OUT_DIR'
tmp = os.path.join(out_dir, '.credentials.tmp')
with open(tmp, 'w') as f:
    f.write('[default]\n')
    f.write(f'aws_access_key_id = {c[\"AccessKeyId\"]}\n')
    f.write(f'aws_secret_access_key = {c[\"SecretAccessKey\"]}\n')
    f.write(f'aws_session_token = {c[\"SessionToken\"]}\n')
os.chmod(tmp, 0o644)
os.replace(tmp, os.path.join(out_dir, 'credentials'))
print('refreshed, expires', c['Expiration'])
"

CONFIG="$OUT_DIR/config"
if [ ! -f "$CONFIG" ]; then
  printf '[default]\nregion = %s\noutput = json\n' "$REGION" > "$CONFIG"
  chmod 644 "$CONFIG"
fi
