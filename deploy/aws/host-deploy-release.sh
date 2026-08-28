#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077
export AWS_PAGER=""

if [[ ${EUID:-$(id -u)} -ne 0 ]]; then
  echo "host-deploy-release must run as root" >&2
  exit 1
fi

release_tag=${1:-}
if [[ ! $release_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || [[ $release_tag == latest ]]; then
  echo "release tag must be immutable, valid, and not latest" >&2
  exit 2
fi

# Contains only identifiers and ARNs, never secret values.
source /etc/guillermo/deployment.conf
: "${AWS_REGION:?AWS_REGION is missing from deployment.conf}"
: "${COORDINATOR_REPOSITORY_URL:?COORDINATOR_REPOSITORY_URL is missing from deployment.conf}"
: "${WORKER_REPOSITORY_URL:?WORKER_REPOSITORY_URL is missing from deployment.conf}"
: "${RUNTIME_SECRET_ARN:?RUNTIME_SECRET_ARN is missing from deployment.conf}"
: "${GITHUB_PRIVATE_KEY_SECRET_ARN:?GITHUB_PRIVATE_KEY_SECRET_ARN is missing from deployment.conf}"
: "${COORDINATOR_LOG_GROUP_NAME:?COORDINATOR_LOG_GROUP_NAME is missing from deployment.conf; update trusted host assets through SSM first}"

runtime_response=$(mktemp /etc/guillermo/.runtime-response.XXXXXX)
runtime_json=$(mktemp /etc/guillermo/.runtime-json.XXXXXX)
runtime_env=$(mktemp /etc/guillermo/.runtime-env.XXXXXX)
key_response=$(mktemp /etc/guillermo/.key-response.XXXXXX)
key_pem=$(mktemp /etc/guillermo/.github-key.XXXXXX)
host_env=$(mktemp /etc/guillermo/.host-env.XXXXXX)
cleanup() {
  if [[ -n ${registry:-} ]]; then docker logout "$registry" >/dev/null 2>&1 || true; fi
  rm -f -- "$runtime_response" "$runtime_json" "$runtime_env" "$key_response" "$key_pem" "$host_env"
}
trap cleanup EXIT

aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$RUNTIME_SECRET_ARN" \
  --output json >"$runtime_response"
jq -er '.SecretString | fromjson' "$runtime_response" >"$runtime_json"

/usr/local/libexec/guillermo/render-runtime-env "$runtime_json" "$runtime_env"

aws secretsmanager get-secret-value \
  --region "$AWS_REGION" \
  --secret-id "$GITHUB_PRIVATE_KEY_SECRET_ARN" \
  --output json >"$key_response"
jq -er '.SecretString' "$key_response" >"$key_pem"
grep -q '^-----BEGIN .*PRIVATE KEY-----$' "$key_pem"
grep -q '^-----END .*PRIVATE KEY-----$' "$key_pem"

install -o root -g guillermo -m 0440 "$runtime_env" /etc/guillermo/runtime.env
install -o root -g guillermo -m 0440 "$key_pem" /etc/guillermo/github-app.pem

docker_gid=$(stat -c '%g' /var/run/docker.sock)
coordinator_image="$COORDINATOR_REPOSITORY_URL:$release_tag"
worker_image="$WORKER_REPOSITORY_URL:$release_tag"
{
  printf 'GUILLERMO_COORDINATOR_IMAGE=%s\n' "$coordinator_image"
  printf 'GUILLERMO_WORKER_IMAGE=%s\n' "$worker_image"
  printf 'GUILLERMO_DOCKER_GID=%s\n' "$docker_gid"
  printf 'GUILLERMO_DOCKER_SOCKET_PATH=/var/run/docker.sock\n'
  printf 'DOCKER_HOST=unix:///var/run/docker.sock\n'
  printf 'GUILLERMO_AWS_REGION=%s\n' "$AWS_REGION"
  printf 'GUILLERMO_CLOUDWATCH_LOG_GROUP=%s\n' "$COORDINATOR_LOG_GROUP_NAME"
  printf 'GUILLERMO_CLOUDWATCH_LOG_STREAM=coordinator-%s\n' "$release_tag"
} >"$host_env"
install -o root -g guillermo -m 0440 "$host_env" /etc/guillermo/host.env

registry=${COORDINATOR_REPOSITORY_URL%%/*}
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$registry" >/dev/null
docker pull "$coordinator_image" >/dev/null
docker pull "$worker_image" >/dev/null
docker image inspect "$coordinator_image" "$worker_image" >/dev/null

runuser -u guillermo -- docker compose --env-file /etc/guillermo/host.env -f /opt/guillermo/compose.yaml config --quiet
systemctl restart guillermo.service
for _attempt in $(seq 1 30); do
  container_health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' guillermo-coordinator 2>/dev/null || true)
  if [[ $container_health == healthy ]]; then
    echo "Guillermo release $release_tag is running and healthy."
    exit 0
  fi
  if [[ $container_health == exited || $container_health == dead ]]; then break; fi
  sleep 2
done
echo "Guillermo release $release_tag did not become healthy; inspect systemd and container logs." >&2
exit 1
