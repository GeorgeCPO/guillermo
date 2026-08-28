#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
export AWS_PAGER=""

usage() {
  cat <<'EOF'
Usage:
  AWS_REGION=... INSTANCE_ID=i-... RELEASE_TAG=<immutable-tag> \
  COORDINATOR_LOG_GROUP_NAME=/guillermo/coordinator \
  ./deploy/aws/update-host-assets-via-ssm.sh

Installs the source-controlled trusted host assets through Systems Manager,
then redeploys the already-published immutable coordinator/worker release.
It does not build or push application images and does not use SSH.
EOF
}
if [[ ${1:-} == --help ]]; then usage; exit 0; fi

for tool in aws jq tar base64 shasum; do
  command -v "$tool" >/dev/null || { echo "Required tool not found: $tool" >&2; exit 1; }
done
aws_region=${AWS_REGION:?AWS_REGION is required}
instance_id=${INSTANCE_ID:?INSTANCE_ID is required}
release_tag=${RELEASE_TAG:?RELEASE_TAG is required}
coordinator_log_group_name=${COORDINATOR_LOG_GROUP_NAME:?COORDINATOR_LOG_GROUP_NAME is required}
if [[ ! $instance_id =~ ^i-[0-9a-f]+$ ]]; then echo "Invalid INSTANCE_ID" >&2; exit 2; fi
if [[ -z $coordinator_log_group_name ]] || (( ${#coordinator_log_group_name} > 512 )) || [[ $coordinator_log_group_name =~ [^./_#A-Za-z0-9-] ]]; then
  echo "COORDINATOR_LOG_GROUP_NAME is invalid" >&2
  exit 2
fi
if [[ ! $release_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || [[ $release_tag == latest ]]; then
  echo "RELEASE_TAG must be immutable, valid, and not latest" >&2
  exit 2
fi

root_dir=$(cd "$(dirname "$0")/../.." && pwd)
assets=(
  deploy/aws/compose.yaml
  deploy/aws/host-deploy-release.sh
  deploy/aws/render-runtime-env.sh
  deploy/aws/install-host-assets.sh
)
for asset in "${assets[@]}"; do
  [[ -f $root_dir/$asset ]] || { echo "Trusted host asset not found: $asset" >&2; exit 1; }
done

archive=$(mktemp)
cleanup() { rm -f -- "$archive"; }
trap cleanup EXIT
tar -czf "$archive" -C "$root_dir" "${assets[@]}"
archive_sha256=$(shasum -a 256 "$archive" | awk '{print $1}')
archive_base64=$(base64 <"$archive" | tr -d '\r\n')
if (( ${#archive_base64} > 18000 )); then
  echo "Trusted host asset payload is too large for the guarded SSM command path" >&2
  exit 1
fi

remote_command=$(jq -nr \
  --arg archive "$archive_base64" \
  --arg sha256 "$archive_sha256" \
  --arg log_group "$coordinator_log_group_name" \
  --arg release "$release_tag" '
    [
      "set -Eeuo pipefail",
      "set +x",
      "umask 077",
      "asset_dir=$(mktemp -d /var/tmp/guillermo-host-assets.XXXXXX)",
      "cleanup() { rm -rf -- \"$asset_dir\"; }",
      "trap cleanup EXIT",
      "printf %s " + ($archive | @sh) + " | base64 --decode >\"$asset_dir/assets.tar.gz\"",
      "printf \"%s  %s\\n\" " + ($sha256 | @sh) + " \"$asset_dir/assets.tar.gz\" | sha256sum --check --status",
      "tar -xzf \"$asset_dir/assets.tar.gz\" -C \"$asset_dir\"",
      "chmod 0750 \"$asset_dir/deploy/aws/install-host-assets.sh\"",
      "\"$asset_dir/deploy/aws/install-host-assets.sh\" " + ($log_group | @sh) + " " + ($release | @sh)
    ] | join("\n")
  ')
if ! bash -n <<<"$remote_command"; then
  echo "Generated SSM host command failed local shell syntax validation" >&2
  exit 1
fi
parameters=$(jq -cn --arg command "$remote_command" '{commands:[$command]}')

aws sts get-caller-identity >/dev/null
command_id=$(aws ssm send-command \
  --region "$aws_region" \
  --instance-ids "$instance_id" \
  --document-name AWS-RunShellScript \
  --comment "Update Guillermo trusted host assets for immutable release $release_tag" \
  --parameters "$parameters" \
  --query 'Command.CommandId' \
  --output text)
printf 'SSM command: %s\n' "$command_id"

if ! aws ssm wait command-executed --region "$aws_region" --command-id "$command_id" --instance-id "$instance_id"; then
  status=$(aws ssm get-command-invocation --region "$aws_region" --command-id "$command_id" --instance-id "$instance_id" --query Status --output text)
  echo "Host-asset update did not succeed (status: $status). Inspect the SSM command invocation; its output contains no secret values by design." >&2
  exit 1
fi
status=$(aws ssm get-command-invocation --region "$aws_region" --command-id "$command_id" --instance-id "$instance_id" --query Status --output text)
printf 'Host-asset update status: %s\n' "$status"
