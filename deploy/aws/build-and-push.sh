#!/usr/bin/env bash
set -Eeuo pipefail
set +x
export AWS_PAGER=""

usage() {
  cat <<'EOF'
Usage: AWS_REGION=... COORDINATOR_ECR_REPOSITORY_URL=... WORKER_ECR_REPOSITORY_URL=... \
       [RELEASE_TAG=<immutable-tag>] [TARGET_ARCH=x86_64|arm64] ./deploy/aws/build-and-push.sh

Builds and pushes both production images. RELEASE_TAG defaults to the current
Git commit SHA. Set ALLOW_DIRTY=1 only when intentionally releasing a dirty tree.
EOF
}

if [[ ${1:-} == --help ]]; then usage; exit 0; fi

for tool in aws docker git; do
  command -v "$tool" >/dev/null || { echo "Required tool not found: $tool" >&2; exit 1; }
done
docker buildx version >/dev/null

aws_region=${AWS_REGION:?AWS_REGION is required}
coordinator_repo=${COORDINATOR_ECR_REPOSITORY_URL:?COORDINATOR_ECR_REPOSITORY_URL is required}
worker_repo=${WORKER_ECR_REPOSITORY_URL:?WORKER_ECR_REPOSITORY_URL is required}
git_sha=$(git rev-parse HEAD)
release_tag=${RELEASE_TAG:-$git_sha}
target_arch=${TARGET_ARCH:-x86_64}

if [[ ! $release_tag =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || [[ $release_tag == latest ]]; then
  echo "RELEASE_TAG must be immutable, valid, and not latest" >&2
  exit 2
fi
case "$target_arch" in
  x86_64) platform=linux/amd64 ;;
  arm64) platform=linux/arm64 ;;
  *) echo "TARGET_ARCH must be x86_64 or arm64" >&2; exit 2 ;;
esac

git rev-parse --is-inside-work-tree >/dev/null
repository_status=$(git status --porcelain --untracked-files=normal)
if [[ ${ALLOW_DIRTY:-0} != 1 ]] && [[ -n $repository_status ]]; then
  echo "Refusing to release a modified or untracked working tree; commit changes first or set ALLOW_DIRTY=1." >&2
  exit 2
fi

identity_account=$(aws sts get-caller-identity --query Account --output text)
expected_prefix="$identity_account.dkr.ecr.$aws_region."
if [[ $coordinator_repo != "$expected_prefix"* ]] || [[ $worker_repo != "$expected_prefix"* ]]; then
  echo "ECR repository URLs do not match the authenticated AWS account and region." >&2
  exit 2
fi

registry=${coordinator_repo%%/*}
if [[ ${worker_repo%%/*} != "$registry" ]]; then
  echo "Coordinator and worker repositories must use the same ECR registry." >&2
  exit 2
fi
aws ecr describe-repositories --region "$aws_region" --repository-names "${coordinator_repo#*/}" "${worker_repo#*/}" >/dev/null
aws ecr get-login-password --region "$aws_region" | docker login --username AWS --password-stdin "$registry" >/dev/null

coordinator_image="$coordinator_repo:$release_tag"
worker_image="$worker_repo:$release_tag"
build_date=$(date -u +'%Y-%m-%dT%H:%M:%SZ')
source_url=${SOURCE_URL:-unknown}
if [[ $source_url == *$'\n'* ]] || [[ $source_url == *$'\r'* ]]; then
  echo "SOURCE_URL must be a single-line OCI source URL or unknown." >&2
  exit 2
fi

docker buildx build --platform "$platform" --file Dockerfile.coordinator \
  --build-arg "BUILD_DATE=$build_date" --build-arg "VCS_REF=$git_sha" --build-arg "VERSION=$release_tag" --build-arg "SOURCE_URL=$source_url" \
  --tag "$coordinator_image" --provenance=true --sbom=true --push .
docker buildx build --platform "$platform" --file Dockerfile.worker \
  --tag "$worker_image" --provenance=true --sbom=true --push .

release_env_file=${RELEASE_ENV_FILE:-/tmp/guillermo-release-$release_tag.env}
umask 077
{
  printf 'RELEASE_TAG=%s\n' "$release_tag"
  printf 'GUILLERMO_COORDINATOR_IMAGE=%s\n' "$coordinator_image"
  printf 'GUILLERMO_WORKER_IMAGE=%s\n' "$worker_image"
} >"$release_env_file"

printf 'Published coordinator: %s\nPublished worker: %s\nRelease metadata: %s\n' \
  "$coordinator_image" "$worker_image" "$release_env_file"
