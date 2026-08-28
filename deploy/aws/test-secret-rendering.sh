#!/usr/bin/env bash
set -Eeuo pipefail

root_dir=$(cd "$(dirname "$0")/../.." && pwd)
fixture=$(mktemp)
rendered=$(mktemp)
output=$(mktemp)
cleanup() { rm -f -- "$fixture" "$rendered" "$output"; }
trap cleanup EXIT

printf '%s\n' '{"OPENAI_API_KEY":"test-openai-do-not-log","GUILLERMO_JIRA_WEBHOOK_SECRET":"test-webhook-do-not-log","GUILLERMO_JIRA_PROJECTS":{"APP":{"repository":"org/repo","baseBranch":"main"}},"GUILLERMO_GITHUB_APP_ID":"123","GUILLERMO_GITHUB_APP_INSTALLATION_ID":"456","GUILLERMO_GIT_AUTHOR_NAME":"Guillermo Bot","GUILLERMO_GIT_AUTHOR_EMAIL":"bot@example.test","GUILLERMO_MAX_STEPS":"50"}' >"$fixture"

"$root_dir/deploy/aws/render-runtime-env.sh" "$fixture" "$rendered" >"$output"
[[ ! -s $output ]]
grep -q '^OPENAI_API_KEY=test-openai-do-not-log$' "$rendered"
grep -q '^GUILLERMO_JIRA_PROJECTS={"APP":{"repository":"org/repo","baseBranch":"main"}}$' "$rendered"
grep -q '^GUILLERMO_MAX_STEPS=50$' "$rendered"
[[ $(stat -f '%Lp' "$rendered" 2>/dev/null || stat -c '%a' "$rendered") == 440 ]]

sed 's/"GUILLERMO_MAX_STEPS":"50"/"GUILLERMO_MAX_STEPS":"51"/' "$fixture" >"$fixture.invalid"
if "$root_dir/deploy/aws/render-runtime-env.sh" "$fixture.invalid" "$rendered" >"$output" 2>&1; then
  echo "invalid max steps unexpectedly rendered" >&2
  exit 1
fi
rm -f -- "$fixture.invalid"

printf 'secret rendering simulation passed without stdout exposure\n'
