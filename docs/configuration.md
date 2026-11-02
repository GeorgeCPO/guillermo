# Configuration reference

Guillermo is configured entirely through environment variables and, for the CLI, command-line flags. `.env.example` is the annotated template. At startup, a `.env` file in the **current working directory** is loaded if present; variables already set in the process environment win over the file.

In the AWS deployment the same variables come from AWS Secrets Manager instead; see the [runbook](../deploy/aws/RUNBOOK.md#3-create-secret-values-outside-terraform).

## Agent (CLI and webhook)

| Variable | Required | Default | Rules |
| --- | --- | --- | --- |
| `OPENAI_API_KEY` | yes | — | Used with the OpenAI Responses API. |
| `GUILLERMO_MODEL` | no | `gpt-5.6-terra` | Any Responses-API model that supports function calling. `--model` overrides it. |
| `GUILLERMO_MAX_STEPS` | no | `20` | Integer 1–50. Caps model/tool cycles per run. `--max-steps` overrides it. |

## Webhook service

All of these are required unless a default is shown.

| Variable | Default | Rules |
| --- | --- | --- |
| `GUILLERMO_JIRA_WEBHOOK_SECRET` | — | At least 16 bytes. Compared against the `X-Guillermo-Webhook-Secret` request header. |
| `GUILLERMO_JIRA_PROJECTS` | — | Single-line JSON object mapping an uppercase Jira project key to `{ "repository": "owner/name", "baseBranch": "main", "prTitleFormat": "[{issueKey}] {summary}" }`. `prTitleFormat` is optional and supports only the `{issueKey}` and `{summary}` placeholders. This is the server-side allowlist; a webhook cannot choose any of these values. |
| `GUILLERMO_GITHUB_APP_ID` | — | Positive integer. |
| `GUILLERMO_GITHUB_APP_INSTALLATION_ID` | — | Positive integer. |
| `GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH` | — | Absolute path to the App's PEM file. Read when a job starts, never copied into a checkout or passed to a worker. |
| `GUILLERMO_GIT_AUTHOR_NAME` | — | Single line, up to 100 characters. Commit author for webhook jobs. |
| `GUILLERMO_GIT_AUTHOR_EMAIL` | — | Valid email, up to 254 characters. |
| `GUILLERMO_WORKSPACE_ROOT` | — | Normalized absolute directory path (not `/`, no commas or control characters). Every job gets a unique subdirectory that is deleted afterwards. When the coordinator runs in a container it must be bind-mounted at the identical path, because the host Docker daemon resolves worker mounts. |
| `GUILLERMO_WEBHOOK_HOST` | `127.0.0.1` | Listen address. Keep the loopback default unless a reverse proxy or load balancer needs to reach it. |
| `GUILLERMO_WEBHOOK_PORT` | `3000` | Integer 1–65535. |

## Docker worker sandbox

| Variable | Default | Rules |
| --- | --- | --- |
| `GUILLERMO_DOCKER_IMAGE` | `guillermo-worker:latest` | Single-line image reference. Must already exist locally; jobs run with `--pull never`. |
| `GUILLERMO_DOCKER_MEMORY` | `1g` | Docker memory value from `64m` to `64g`. |
| `GUILLERMO_DOCKER_CPUS` | `2` | Number from 0.1 to 64. |
| `GUILLERMO_DOCKER_PIDS` | `256` | Integer 16–4096. |

## CLI flags

```
npm run cli -- --repo <path> --task <description> [options]
```

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Repository to change (required). Relative paths are resolved against the current directory. |
| `--task <description>` | The change to make (required). |
| `--branch <name>` | Working branch name. Existing or invalid names are refused. |
| `--base <branch>` | Pull-request base branch. Default: the branch checked out when the run started. |
| `--pr-title <title>` | Pull-request title. Default: derived from the task. |
| `--model <model>` | Model override. |
| `--max-steps <count>` | Step cap, 1–50. |
| `-h`, `--help` | Show usage. |

Each flag may be given once; unknown flags and positional arguments are errors.

## Fixed limits (not configurable)

| Limit | Value |
| --- | --- |
| Webhook request body | 256,000 bytes |
| Clone timeout | 5 minutes |
| `search_repository` | text files under 100 KB, at most 100 matching lines |
| Graceful shutdown wait for in-flight jobs | 30 seconds |

Dependency-installation and test timeouts and output caps are defined in `src/application/` and `src/infrastructure/`.
