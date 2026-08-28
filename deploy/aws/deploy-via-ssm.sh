#!/usr/bin/env bash
set -Eeuo pipefail
set +x
export AWS_PAGER=""

usage() {
  cat <<'EOF'
Usage: AWS_REGION=... INSTANCE_ID=i-... RELEASE_TAG=<immutable-tag> ./deploy/aws/deploy-via-ssm.sh

Invokes the idempotent host deployment utility through AWS Systems Manager.
No SSH port or key is used.
EOF
}
if [[ ${1:-} == --help ]]; then usage; exit 0; fi

for tool in aws jq; do
  command -v "$tool" >/dev/null || { echo "Required tool not found: $tool" >&2; exit 1; }
done
aws_region=${AWS_REGION:?AWS_REGION is required}
instance_id=${INSTANCE_ID:?INSTANCE_ID is required}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
if [[ ! $instance_id =~ ^i-[0-9a-f]+$ ]]; then echo "Invalid INSTANCE_ID" >&2; exit 2; fi
if [[ ! $release_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || [[ $release_tag == latest ]]; then
  echo "RELEASE_TAG must be immutable, valid, and not latest" >&2
  exit 2
fi

aws sts get-caller-identity >/dev/null
parameters=$(jq -cn --arg command "sudo /usr/local/sbin/guillermo-deploy-release '$release_tag'" '{commands:[$command]}')
command_id=$(aws ssm send-command \
  --region "$aws_region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Deploy Guillermo immutable release $release_tag" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)
printf 'SSM command: %s\n' "$command_id"

if ! aws ssm wait command-executed --region "$aws_region" --command-id "$command_id" --instance-id "$instance_id"; then
  status=$(aws ssm get-command-invocation --region "$aws_region" --command-id "$command_id" --instance-id "$instance_id" --query Status --output text)
  echo "Deployment command did not succeed (status: $status). Inspect it with aws ssm get-command-invocation." >&2
  exit 1
fi
status=$(aws ssm get-command-invocation --region "$aws_region" --command-id "$command_id" --instance-id "$instance_id" --query Status --output text)
printf 'Deployment status: %s\n' "$status"
