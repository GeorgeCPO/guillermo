# Guillermo

Guillermo is a small coding agent built to learn how an LLM can work on a repository safely and transparently. Its local CLI can publish through an existing GitHub CLI login. Its unattended Jira workflow uses a GitHub App, a fresh temporary clone, ephemeral Docker workers for repository-controlled commands, and the GitHub REST API instead of a developer account.

## What it does

Given a task and a target Git repository, Guillermo asks an OpenAI model to use six narrow tools:

1. `list_files` — inspect the repository tree.
2. `read_file` — inspect a text file in the repository.
3. `search_repository` — find literal text in bounded repository text files.
4. `apply_patch` — apply a validated unified diff.
5. `run_tests` — run a package-manager test command from a small allowlist.
6. `finish` — declare completion with a concise summary.

Before the run, Guillermo requires a clean working tree and creates a new local working branch from the current commit. After a successful `finish`, at least one changed file, and at least one passing `run_tests` result, it creates one commit, pushes that newly created branch to `origin`, and creates a GitHub pull request into the starting branch. The report includes the commit SHA, pushed branch, PR URL, or the reason publishing was skipped. Guillermo has no general shell tool and refuses patches outside the selected repository.

## HTTP service and Jira webhook (Stages 9–10)

The Stage 9.5 trigger is deliberately exact: a Jira `comment_created` webhook starts work only when the entire plain-text comment is `/guillermo` (surrounding whitespace is allowed). Jira Cloud's Atlassian Document Format is also accepted when it resolves to that exact text. Text after the command is not treated as an instruction. The coding task is built only from the validated issue key, project key, summary, and description.

Every request to `POST /webhooks/jira` must include the configured secret in `X-Guillermo-Webhook-Secret`. Missing or incorrect authentication returns `401` before the body is parsed. Use HTTPS at the public edge—for example, a trusted tunnel or reverse proxy—and have Jira Automation send a POST request with that custom header and the Jira webhook JSON body. A minimal payload looks like:

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

The project key selects a server-owned allowlist in `GUILLERMO_JIRA_PROJECTS`. A webhook cannot select a repository, clone URL, credentials, organization, filesystem path, base branch, PR-title template, shell command, model, or other agent configuration. The JSON setting maps each allowed project to a GitHub `owner/name` identity, a base branch, and an optional PR title format. Only `{issueKey}` and `{summary}` placeholders are supported:

```dotenv
GUILLERMO_JIRA_WEBHOOK_SECRET=replace-with-a-long-random-secret
GUILLERMO_JIRA_PROJECTS={"APP":{"repository":"my-org/app","baseBranch":"main","prTitleFormat":"[{issueKey}] {summary}"}}
GUILLERMO_GITHUB_APP_ID=123456
GUILLERMO_GITHUB_APP_INSTALLATION_ID=789012
GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/to/github-app-private-key.pem
GUILLERMO_GIT_AUTHOR_NAME=Guillermo Bot
GUILLERMO_GIT_AUTHOR_EMAIL=guillermo-bot@example.com
GUILLERMO_WORKSPACE_ROOT=/absolute/path/to/guillermo-workspaces
GUILLERMO_DOCKER_IMAGE=guillermo-worker:latest
GUILLERMO_DOCKER_MEMORY=1g
GUILLERMO_DOCKER_CPUS=2
GUILLERMO_DOCKER_PIDS=256
GUILLERMO_WEBHOOK_HOST=127.0.0.1
GUILLERMO_WEBHOOK_PORT=3000
```

Build the pinned Node 22 worker image, then start the local Fastify HTTP service after completing the regular setup:

```bash
npm run docker:build
npm run dev
```

For a production build, compile and launch the same HTTP entrypoint:

```bash
npm run build
npm start
```

For a local smoke test, replace the header value with the value in your `.env`:

```bash
curl --request POST http://127.0.0.1:3000/webhooks/jira \
  --header 'Content-Type: application/json' \
  --header 'X-Guillermo-Webhook-Secret: replace-with-a-long-random-secret' \
  --data '{"webhookEvent":"comment_created","issue":{"key":"APP-42","fields":{"project":{"key":"APP"},"summary":"Handle encoded URLs","description":"Preserve query strings."}},"comment":{"id":"9001","body":"/guillermo"}}'
```

Accepted work receives `202` before the coding run begins. JSON logs record accepted, rejected, duplicate, started, completed, and failed events using issue/event metadata but never request bodies or secrets. Concurrent redeliveries of the same issue/comment event are suppressed in memory. Jobs are serialized by canonical identities such as `github.com/my-org/app`; different repositories can run concurrently.

For every accepted job, Guillermo creates a unique temporary directory, clones only the configured repository and base branch over token-free HTTPS, runs `npm ci` and repository tests in ephemeral Docker workers, executes the agent, commits and pushes only its new branch, and creates the pull request through the GitHub REST API. The entire temporary directory—including the short-lived askpass helper—is removed after success or failure. No previous checkout is reused.

The unattended workflow initially supports only npm projects containing both `package.json` and a committed `package-lock.json`. Dependency installation and repository tests have explicit timeouts and bounded output. Dependency installation is application-controlled; it is not an LLM shell tool.

### Docker isolation (Stage 10)

The webhook server is the trusted coordinator and remains outside the worker containers. It owns Jira validation, OpenAI and GitHub credentials, validated file operations, Git commands, and workspace cleanup. Only repository-controlled execution crosses the Docker boundary:

- `npm ci` runs in a fresh worker with ordinary bridge networking so it can reach the npm registry.
- Every model-selected test command runs in a fresh worker with `--network none`.
- Each worker sees only the current checkout. The checkout is writable, but its `.git` directory is over-mounted read-only to prevent repository scripts from planting Git hooks or changing Git configuration.
- Workers receive a fixed non-secret environment, run with the coordinator user's non-root UID/GID, have a read-only root filesystem, no Linux capabilities, `no-new-privileges`, and explicit CPU, memory, PID, output, and time limits.
- Guillermo never mounts the Docker socket, GitHub App key, askpass helper, another job workspace, or coordinator environment into a worker. Normal exits use `--rm`; timeout, cancellation, and output-limit failures also trigger a forced removal by name.

The server checks both the Docker daemon and configured image before listening and has no host-execution fallback. Run the coordinator as a non-root user. `GUILLERMO_DOCKER_IMAGE` may select an operator-built immutable image; jobs use `--pull never`, so image acquisition cannot happen as a side effect of an incoming webhook.

This boundary protects the coordinator and sibling jobs from ordinary repository processes, but Docker is not a perfect hostile-code boundary. In particular, `npm ci` requires outbound networking and can reach destinations available from Docker's bridge network. Private registry credentials, native build toolchains, network-dependent tests, custom Docker networks, and stronger egress filtering are deliberately unsupported in this stage.

To run the live Docker isolation integration test after building the image:

```bash
GUILLERMO_RUN_DOCKER_TESTS=1 npm test
```

### GitHub App setup

Create the GitHub App yourself, install it on the intended account or organization, and configure these repository permissions:

- **Contents: Read and write** — clone the configured base, inspect branches, and push the new branch.
- **Pull requests: Read and write** — create the pull request.
- **Metadata: Read-only** — GitHub includes this mandatory baseline permission.

Install the App on **only selected repositories** when practical. The installation ID determines the installation scope; `GUILLERMO_JIRA_PROJECTS` is Guillermo's additional runtime allowlist. Adding a repository therefore changes the App installation/runtime configuration, not the Guillermo build or a future container image.

Set the App ID, installation ID, absolute private-key file path, and commit author values shown above. Protect the key file with host filesystem permissions and rotate it through GitHub when needed. Guillermo signs a short-lived App JWT, requests a short-lived installation token with only `contents: write` and `pull_requests: write`, refreshes it near expiration, and keeps it out of command arguments, remote URLs, persisted Git configuration, logs, errors, and reports.

## AWS single-instance deployment (Stage 10.5)

The production coordinator image, hardened EC2 Compose definition, Terraform infrastructure, Amazon Linux 2023 bootstrap, immutable ECR release scripts, SSM update path, CloudWatch Logs storage, secret contract, and operations guide live in [`deploy/aws`](deploy/aws/RUNBOOK.md). The deployment preserves the Stage 10 split: the trusted coordinator is persistent, while repository-controlled commands run only in separate ephemeral worker containers.

Start with the [Stage 10.5 deployment runbook](deploy/aws/RUNBOOK.md). Terraform never reads secret values, and the provided scripts do not apply infrastructure, publish images, or contact AWS unless an operator runs the documented commands.

## Local setup

```bash
npm install
cp .env.example .env
# Add your OpenAI API key to .env. Guillermo loads it automatically at startup.
# You can also export it in your shell; exported values take precedence.

# Authenticate the GitHub CLI once for local CLI publishing only.
gh auth login

# Required before running the unattended Jira webhook server.
npm run docker:build
```

## Run the CLI

Point it at another Git repository (not Guillermo itself unless that is intentional):

```bash
npm run cli -- --help
```

```bash
npm run cli -- \
  --repo /absolute/path/to/a/repository \
  --task "Add a test for the URL parser and fix any bug the test identifies"
```

By default, the working branch is derived deterministically from the task (for example, `guillermo/add-url-parser-tests`). Use `--branch` to choose its name; Guillermo refuses existing or invalid names.

Use `--base` to target a different base branch, or `--pr-title` to choose the pull-request title. Without them, the base is the branch Guillermo started from and both the commit message and title are derived from the task. `--model` overrides `GUILLERMO_MODEL`, `--max-steps` caps tool calls (the default is 20), and `--branch` names the new branch:

```bash
npm run cli -- \
  --repo /path/to/repo \
  --task "Add parser coverage" \
  --branch guillermo/parser-coverage \
  --base main \
  --pr-title "Add parser coverage" \
  --max-steps 12
```

## Deliberate limits

- GitHub publishing happens only after `finish`, a file change, and a passing `run_tests` result. An agent failure, a step-limit exit, no changes, or no passing test skips commit, push, and PR creation with an explanation in the report.
- Local CLI publishing requires a configured `origin` and an authenticated `gh` session. Unattended webhook publishing instead requires the configured GitHub App and never depends on `gh` or a developer account. Neither mode force-pushes or overwrites an existing remote branch.
- It stages the changed paths from this clean-start run into one generated commit, then pushes only that new working branch. It refuses to publish if `HEAD` moved during the run, so it will not add a second commit to a branch. It cannot distinguish intentional agent edits from files a project's test command itself modifies, so test commands should not produce tracked artifacts.
- A detached starting `HEAD`, inaccessible `origin`, unavailable/expired authentication, branch-protection rules, or GitHub API failures can prevent publishing. The local CLI leaves any commit already created in place. A webhook workspace is always removed after reporting the outcome; Guillermo does not retry with broader permissions or modify repository settings.
- It refuses to run against a dirty working tree or an existing working-branch name.
- Webhook deduplication and repository queues exist only in this process. A restart forgets accepted/completed event IDs, and there are no durable jobs, retries, Jira status/comment updates, approval controls, or delivery recovery; those belong to later stages.
- The local CLI leaves the created branch checked out. Webhook jobs start from a fresh shallow clone of the configured remote base branch and do not retain a checkout after completion.
- Docker isolation is mandatory for webhook jobs but is not used by the interactive local CLI. The Stage 10 worker supports npm repositories only, and tests run without networking.
- `apply_patch` accepts only repository-relative text-file patches and blocks sensitive paths such as `.env`, `.git`, `node_modules`, and lockfiles.
- `search_repository` stays within the selected repository, honors the same blocked paths and ignored directories, skips binary and over-100 KB files, and returns at most 100 matching lines.
- `run_tests` permits `npm`, `pnpm`, `yarn`, or `bun` test commands only, without shell operators. The local CLI supports those validated runners when installed; unattended Stage 10 workers fail closed on anything except npm.

This is an intentional first slice of the 12-factor approach: prompts are owned in source, the context is selected by tools, actions are structured outputs, and TypeScript—not the LLM—owns the control flow.
