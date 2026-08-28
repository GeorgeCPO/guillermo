#!/usr/bin/env bash
set -Eeuo pipefail
set +x
umask 077

input_json=${1:?runtime secret JSON file is required}
output_env=${2:?output environment file is required}

jq -er '
  def line($name):
    .[$name] as $value
    | if ($value | type) != "string" or ($value | length) == 0 or ($value | (contains("\r") or contains("\n") or contains("\u0000")))
      then error("invalid " + $name) else $value end;
  if (.GUILLERMO_JIRA_PROJECTS | type) != "object" then error("GUILLERMO_JIRA_PROJECTS must be an object") else . end
  | [
      "OPENAI_API_KEY=" + line("OPENAI_API_KEY"),
      "GUILLERMO_JIRA_WEBHOOK_SECRET=" + line("GUILLERMO_JIRA_WEBHOOK_SECRET"),
      "GUILLERMO_JIRA_PROJECTS=" + (.GUILLERMO_JIRA_PROJECTS | tojson),
      "GUILLERMO_GITHUB_APP_ID=" + line("GUILLERMO_GITHUB_APP_ID"),
      "GUILLERMO_GITHUB_APP_INSTALLATION_ID=" + line("GUILLERMO_GITHUB_APP_INSTALLATION_ID"),
      "GUILLERMO_GIT_AUTHOR_NAME=" + line("GUILLERMO_GIT_AUTHOR_NAME"),
      "GUILLERMO_GIT_AUTHOR_EMAIL=" + line("GUILLERMO_GIT_AUTHOR_EMAIL")
    ] | .[]
' "$input_json" >"$output_env"

chmod 0440 "$output_env"
