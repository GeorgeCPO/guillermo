#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "install-host-assets must run as root" >&2
  exit 1
fi

coordinator_log_group_name=${1:-}
release_tag=${2:-}
if [[ -z $coordinator_log_group_name ]] || (( ${#coordinator_log_group_name} > 512 )) || [[ $coordinator_log_group_name =~ [^./_#A-Za-z0-9-] ]]; then
  echo "coordinator log group name is invalid" >&2
  exit 2
fi
if [[ ! $release_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || [[ $release_tag == latest ]]; then
  echo "release tag must be immutable, valid, and not latest" >&2
  exit 2
fi

asset_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
for asset in compose.yaml host-deploy-release.sh render-runtime-env.sh; do
  [[ -f $asset_dir/$asset ]] || { echo "trusted host asset is missing: $asset" >&2; exit 1; }
done
[[ -f /etc/guillermo/deployment.conf ]] || { echo "deployment.conf is missing" >&2; exit 1; }
getent group guillermo >/dev/null || { echo "guillermo group is missing" >&2; exit 1; }

stage_dir=$(mktemp -d /opt/guillermo/.asset-update.XXXXXX)
cleanup() { rm -rf -- "$stage_dir"; }
trap cleanup EXIT

# deployment.conf contains identifiers and ARNs only. Preserve the values
# originally rendered by Terraform and replace just this non-secret setting.
grep -v '^COORDINATOR_LOG_GROUP_NAME=' /etc/guillermo/deployment.conf >"$stage_dir/deployment.conf"
printf 'COORDINATOR_LOG_GROUP_NAME=%s\n' "$coordinator_log_group_name" >>"$stage_dir/deployment.conf"

install -o root -g root -m 0644 "$asset_dir/compose.yaml" "$stage_dir/compose.yaml"
install -o root -g root -m 0750 "$asset_dir/host-deploy-release.sh" "$stage_dir/host-deploy-release"
install -o root -g root -m 0755 "$asset_dir/render-runtime-env.sh" "$stage_dir/render-runtime-env"

# Atomically replace every trusted file so a terminated SSM command cannot
# leave a partially written Compose definition or executable.
install -o root -g root -m 0644 "$stage_dir/compose.yaml" /opt/guillermo/.compose.yaml.new
mv -f /opt/guillermo/.compose.yaml.new /opt/guillermo/compose.yaml
install -o root -g root -m 0750 "$stage_dir/host-deploy-release" /usr/local/sbin/.guillermo-deploy-release.new
mv -f /usr/local/sbin/.guillermo-deploy-release.new /usr/local/sbin/guillermo-deploy-release
install -o root -g root -m 0755 "$stage_dir/render-runtime-env" /usr/local/libexec/guillermo/.render-runtime-env.new
mv -f /usr/local/libexec/guillermo/.render-runtime-env.new /usr/local/libexec/guillermo/render-runtime-env
install -o root -g root -m 0600 "$stage_dir/deployment.conf" /etc/guillermo/.deployment.conf.new
mv -f /etc/guillermo/.deployment.conf.new /etc/guillermo/deployment.conf

# This refreshes secrets into protected files without printing them, writes the
# non-secret host.env logging settings, validates Compose, and recreates only
# the coordinator with the already-published immutable images.
/usr/local/sbin/guillermo-deploy-release "$release_tag"
