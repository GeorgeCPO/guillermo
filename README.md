# Guillermo

Guillermo is a small local coding agent built to learn how an LLM can work on a repository safely and transparently. It can open a GitHub pull request through your existing GitHub CLI login and can accept a narrowly authenticated Jira trigger; it does not store GitHub credentials.

## What it does

Given a task and a target Git repository, Guillermo asks an OpenAI model to use six narrow tools:

1. `list_files` — inspect the repository tree.
2. `read_file` — inspect a text file in the repository.
3. `search_repository` — find literal text in bounded repository text files.
4. `apply_patch` — apply a validated unified diff.
5. `run_tests` — run a package-manager test command from a small allowlist.
6. `finish` — declare completion with a concise summary.

Before the run, Guillermo requires a clean working tree and creates a new local working branch from the current commit. After a successful `finish`, at least one changed file, and at least one passing `run_tests` result, it creates one commit, pushes that newly created branch to `origin`, and creates a GitHub pull request into the starting branch. The report includes the commit SHA, pushed branch, PR URL, or the reason publishing was skipped. Guillermo has no general shell tool and refuses patches outside the selected repository.

## Jira webhook (Stage 9)

The Stage 9 trigger is deliberately exact: a Jira `comment_created` webhook starts work only when the entire plain-text comment is `/guillermo` (surrounding whitespace is allowed). Jira Cloud's Atlassian Document Format is also accepted when it resolves to that exact text. Text after the command is not treated as an instruction. The coding task is built only from the validated issue key, project key, summary, and description.

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

The project key selects a server-owned allowlist in `GUILLERMO_JIRA_PROJECTS`. A webhook cannot select a repository, base branch, PR-title template, shell command, model, or other agent configuration. The JSON setting maps each allowed project to an absolute local repository path, a base branch, and an optional PR title format. Only `{issueKey}` and `{summary}` placeholders are supported:

```dotenv
GUILLERMO_JIRA_WEBHOOK_SECRET=replace-with-a-long-random-secret
GUILLERMO_JIRA_PROJECTS={"APP":{"repositoryPath":"/absolute/path/to/app","baseBranch":"main","prTitleFormat":"[{issueKey}] {summary}"}}
GUILLERMO_WEBHOOK_HOST=127.0.0.1
GUILLERMO_WEBHOOK_PORT=3000
```

Start the local Fastify listener after completing the regular setup:

```bash
npm run dev:webhooks
```

For a local smoke test, replace the header value with the value in your `.env`:

```bash
curl --request POST http://127.0.0.1:3000/webhooks/jira \
  --header 'Content-Type: application/json' \
  --header 'X-Guillermo-Webhook-Secret: replace-with-a-long-random-secret' \
  --data '{"webhookEvent":"comment_created","issue":{"key":"APP-42","fields":{"project":{"key":"APP"},"summary":"Handle encoded URLs","description":"Preserve query strings."}},"comment":{"id":"9001","body":"/guillermo"}}'
```

Accepted work receives `202` before the coding run begins. JSON logs record accepted, rejected, duplicate, started, completed, and failed events using issue/event metadata but never request bodies or secrets. Concurrent redeliveries of the same issue/comment event are suppressed in memory, and different jobs for one repository are serialized to protect its checkout. Each webhook working branch starts explicitly from the configured local base branch, never from a previous run's leftover `HEAD`.

## Setup

```bash
npm install
cp .env.example .env
# Add your OpenAI API key to .env. Guillermo loads it automatically at startup.
# You can also export it in your shell; exported values take precedence.

# Authenticate the GitHub CLI once. Guillermo uses this existing session and never reads a token.
gh auth login
```

## Run it

Point it at another Git repository (not Guillermo itself unless that is intentional):

```bash
npm run dev -- --help
```

```bash
npm run dev -- \
  --repo /absolute/path/to/a/repository \
  --task "Add a test for the URL parser and fix any bug the test identifies"
```

By default, the working branch is derived deterministically from the task (for example, `guillermo/add-url-parser-tests`). Use `--branch` to choose its name; Guillermo refuses existing or invalid names.

Use `--base` to target a different base branch, or `--pr-title` to choose the pull-request title. Without them, the base is the branch Guillermo started from and both the commit message and title are derived from the task. `--model` overrides `GUILLERMO_MODEL`, `--max-steps` caps tool calls (the default is 20), and `--branch` names the new branch:

```bash
npm run dev -- \
  --repo /path/to/repo \
  --task "Add parser coverage" \
  --branch guillermo/parser-coverage \
  --base main \
  --pr-title "Add parser coverage" \
  --max-steps 12
```

## Deliberate limits

- GitHub publishing happens only after `finish`, a file change, and a passing `run_tests` result. An agent failure, a step-limit exit, no changes, or no passing test skips commit, push, and PR creation with an explanation in the report.
- Guillermo requires a configured `origin`, an authenticated `gh` session, and a remote branch name that does not already exist. It uses argument-array process calls, does not handle tokens, does not alter Git configuration or remotes, and never force-pushes.
- It stages the changed paths from this clean-start run into one generated commit, then pushes only that new working branch. It refuses to publish if `HEAD` moved during the run, so it will not add a second commit to a branch. It cannot distinguish intentional agent edits from files a project's test command itself modifies, so test commands should not produce tracked artifacts.
- A detached starting `HEAD`, inaccessible `origin`, unavailable/expired GitHub CLI authentication, branch-protection rules, or GitHub API failures can prevent publishing. Guillermo leaves any commit already created in place and reports the error; it does not retry with broader permissions or modify repository settings.
- It refuses to run against a dirty working tree or an existing working-branch name.
- Webhook deduplication and repository queues exist only in this process. A restart forgets accepted/completed event IDs, and there are no durable jobs, retries, Jira status/comment updates, approval controls, or delivery recovery; those belong to later stages.
- The Stage 8 workflow leaves the created branch checked out, but later webhook branches start from the configured local base branch. Guillermo does not fetch or update that base automatically, and it still refuses dirty trees, missing local base branches, and existing generated branches rather than cleaning up or overwriting them.
- `apply_patch` accepts only repository-relative text-file patches and blocks sensitive paths such as `.env`, `.git`, `node_modules`, and lockfiles.
- `search_repository` stays within the selected repository, honors the same blocked paths and ignored directories, skips binary and over-100 KB files, and returns at most 100 matching lines.
- `run_tests` permits `npm`, `pnpm`, `yarn`, or `bun` test commands only, without shell operators.

This is an intentional first slice of the 12-factor approach: prompts are owned in source, the context is selected by tools, actions are structured outputs, and TypeScript—not the LLM—owns the control flow.
