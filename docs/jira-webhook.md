# Jira webhook service

The webhook service lets a Jira comment start a coding job, with no developer account involved: it authenticates to GitHub as a GitHub App, works in a fresh temporary clone, and runs repository code only in ephemeral Docker containers. For a hands-on walk-through, start with [local-setup.md](local-setup.md#3-run-the-webhook-service-locally).

## Request flow

```
Jira Automation ──HTTPS POST──► /webhooks/jira
                                   │ 1. check X-Guillermo-Webhook-Secret (401 before parsing the body)
                                   │ 2. validate payload, require comment == "/guillermo"
                                   │ 3. look up project key in GUILLERMO_JIRA_PROJECTS
                                   │ 4. de-duplicate on issue/comment ID, enqueue
                                   ▼
                              202 Accepted  ──►  job runs asynchronously
                                   │
   per job:  temp dir ► shallow clone (token-free HTTPS) ► `npm ci` in worker container
             ► agent loop (tests run in `--network none` workers) ► commit ► push new branch
             ► PR via GitHub REST API ► delete temp dir
```

## The trigger

Work starts only when a Jira `comment_created` event arrives whose **entire** plain-text comment is `/guillermo` (surrounding whitespace is allowed). Jira Cloud's Atlassian Document Format is accepted when it resolves to exactly that text. Anything after the command is ignored, so a comment cannot smuggle in instructions.

The coding task is built only from the validated issue key, project key, summary and description. A webhook cannot choose a repository, clone URL, credentials, organisation, filesystem path, base branch, PR title template, shell command, model or any other agent setting; those come from server configuration (`GUILLERMO_JIRA_PROJECTS` and the other [environment variables](configuration.md)).

Minimal payload:

```json
{
  "webhookEvent": "comment_created",
  "issue": {
    "key": "APP-42",
    "fields": {
      "project": { "key": "APP" },
      "summary": "Handle encoded URLs",
      "description": "Preserve query strings while decoding paths."
    }
  },
  "comment": { "id": "9001", "body": "/guillermo" }
}
```

### Endpoints and responses

| Request | Response |
| --- | --- |
| `GET /healthz` | `200 {"status":"ok"}` — no project, job or configuration details |
| `POST /webhooks/jira`, header missing or wrong | `401` (body is not parsed) |
| `POST /webhooks/jira`, unsupported content type, malformed or invalid JSON, or over 256,000 bytes | `4xx {"status":"rejected"}` |
| `POST /webhooks/jira`, valid event that isn't the trigger | rejected, no work queued |
| `POST /webhooks/jira`, valid trigger | `202 {"status":"accepted"}`, job queued |
| Wrong method on a known path | `405` |
| Unknown path | `404` |

Use HTTPS at the public edge (a load balancer, reverse proxy or tunnel). The service itself speaks plain HTTP and defaults to listening on loopback.

## Configure Jira Automation

In Jira Automation, create a rule that triggers on **comment created** and add a **Send web request** action:

- URL: `https://<your-host>/webhooks/jira`
- Method: `POST`
- Headers: `Content-Type: application/json` and `X-Guillermo-Webhook-Secret: <GUILLERMO_JIRA_WEBHOOK_SECRET>`
- Body: custom data in the shape shown above, using Jira smart values for the issue key, project key, summary, description and comment ID/body.

Never put the secret in the URL.

## Job events

Accepted work gets `202` before the coding run begins. The service writes JSON log lines for each stage; an accepted job normally produces `accepted` → `started` → exactly one of `completed` or `failed`. Terminal records carry stable reason codes, safe counters (agent steps, changed files, test runs) and a duration, and never include task text, repository content, or raw errors.

The full schema, every reason code, example records, and CloudWatch/`jq` queries are in the [runbook's logging section](../deploy/aws/RUNBOOK.md#job-event-lifecycle-and-schema).

Concurrency: redeliveries of the same issue/comment event are suppressed (in memory). Jobs for the *same* repository run one at a time; different repositories run concurrently.

## What a job does

For every accepted job Guillermo:

1. Creates a unique temporary directory under `GUILLERMO_WORKSPACE_ROOT`.
2. Clones only the configured repository and base branch over token-free HTTPS (the short-lived credential is supplied through a temporary askpass helper, not the URL).
3. Runs `npm ci` and later all repository tests inside fresh Docker worker containers.
4. Runs the agent, then commits and pushes **only a new branch** and opens the PR through the GitHub REST API.
5. Deletes the whole temporary directory, including the askpass helper, whether the job succeeded or failed. No checkout is ever reused.

Only npm projects with both `package.json` and a committed `package-lock.json` are supported. Installation and test runs have explicit timeouts and bounded output. Dependency installation is performed by the application, not by an LLM-controlled shell.

## GitHub App setup

Create the GitHub App yourself, install it on the intended account or organisation, and grant these **repository permissions**:

| Permission | Level | Used for |
| --- | --- | --- |
| Contents | Read and write | Clone the base branch, inspect branches, push the new branch |
| Pull requests | Read and write | Create the pull request |
| Metadata | Read-only | Mandatory baseline permission added by GitHub |

Then:

1. Generate a private key in the App settings and save the PEM file somewhere only the service user can read (`chmod 600`).
2. Note the **App ID** and the **installation ID** (visible in the installation URL).
3. Install the App on **only the repositories** Guillermo may change. The installation limits what GitHub will allow; `GUILLERMO_JIRA_PROJECTS` is a second, Guillermo-side allowlist.
4. Set `GUILLERMO_GITHUB_APP_ID`, `GUILLERMO_GITHUB_APP_INSTALLATION_ID`, `GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH` (absolute), and the commit author variables.

Guillermo signs a short-lived App JWT, requests an installation token restricted to `contents: write` and `pull_requests: write`, refreshes it before expiry, and keeps it out of command arguments, remote URLs, persisted Git configuration, logs, errors and reports. To rotate the key, create a new one in GitHub, switch the file, verify a job, then revoke the old key.

## Adding or changing a repository

Edit `GUILLERMO_JIRA_PROJECTS`, make sure the GitHub App installation includes the repository, and restart the service. Neither the code nor the worker image changes.
