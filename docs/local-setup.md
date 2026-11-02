# Local setup

This guide takes you from a fresh clone to a running agent. It is split into three levels so you can stop as soon as you have what you need:

1. [Build and test](#1-build-and-test) — no accounts or keys required.
2. [Run the CLI agent](#2-run-the-cli-agent) — needs an OpenAI API key and, to open pull requests, the GitHub CLI.
3. [Run the webhook service locally](#3-run-the-webhook-service-locally) — needs Docker. A real Jira site and GitHub App are optional.

## Prerequisites

| Tool | Version | Needed for |
| --- | --- | --- |
| Node.js | 22 or newer (`engines` in `package.json`; developed on 24) | everything |
| npm | bundled with Node | everything |
| Git | any recent version | CLI and tests |
| [GitHub CLI](https://cli.github.com) (`gh`) | any recent version | CLI mode pull requests only |
| Docker | a running daemon | webhook mode, and the optional Docker integration test |
| OpenAI API key | — | running the agent (not needed for tests) |

Developed and tested on macOS. Linux should work (the AWS deployment runs on it); on Windows, use WSL.

## 1. Build and test

```bash
git clone <this-repository-url> guillermo
cd guillermo
npm install
npm run check    # type-check src/ and tests/
npm test         # compile to dist-test/ and run the node:test suites
```

Expected result: all tests pass with **1 skipped**. The skipped test is the live Docker isolation test; it is opt-in because it needs the worker image:

```bash
npm run docker:build                        # builds guillermo-worker:latest
GUILLERMO_RUN_DOCKER_TESTS=1 npm test       # also runs the real-container tests
```

Unit tests use fakes for OpenAI, GitHub and Jira, so `npm test` never makes a network call or spends API credit.

Other scripts:

| Script | What it does |
| --- | --- |
| `npm run cli -- <flags>` | Run the CLI agent from TypeScript source (via `tsx`) |
| `npm run dev` | Start the webhook HTTP service from source |
| `npm run build` then `npm start` | Compile to `dist/` and start the compiled webhook service |
| `npm run start:cli -- <flags>` | Run the compiled CLI (after `npm run build`) |
| `npm run docker:build` | Build the worker image `guillermo-worker:latest` |
| `npm run docker:build:coordinator` | Build the coordinator image locally (used by the AWS deployment) |

## 2. Run the CLI agent

### 2.1 Configure

```bash
cp .env.example .env
```

Open `.env` and set `OPENAI_API_KEY`. The other values in that file only matter for the webhook service, so you can leave them as they are for CLI use. Guillermo loads `.env` from the **current directory** automatically; variables already exported in your shell take precedence over the file. `.env` is git-ignored.

Optional: `GUILLERMO_MODEL` (any Responses-API model that supports function calling) and `GUILLERMO_MAX_STEPS` (1–50, default 20). See [configuration.md](configuration.md).

### 2.2 Create a disposable target repository

Do not point the agent at Guillermo's own checkout while you are learning. This creates a tiny project with a deliberately missing feature, pushed to a private GitHub repository you own:

```bash
gh auth login                      # once; choose GitHub.com and HTTPS

mkdir ../guillermo-sandbox && cd ../guillermo-sandbox
git init -b main
cat > package.json <<'EOF'
{ "name": "guillermo-sandbox", "version": "1.0.0", "type": "module",
  "scripts": { "test": "node --test" } }
EOF
cat > slug.js <<'EOF'
export function slugify(text) {
  return text.toLowerCase().replace(/ /g, "-");
}
EOF
cat > slug.test.js <<'EOF'
import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "./slug.js";

test("slugify lowercases and joins words", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});
EOF
npm install                        # creates package-lock.json
git add . && git commit -m "Initial commit"
gh repo create guillermo-sandbox --private --source=. --push
cd ../guillermo
```

### 2.3 Run it

```bash
npm run cli -- \
  --repo ../guillermo-sandbox \
  --task "slugify should also strip punctuation, and collapse repeated separators. Add tests."
```

What you should see: after the agent finishes, a report containing the summary, why the agent stopped, the branch names, each tool call, the changed files, test output, the pull-request result and the full diff. On success the report ends with a commit SHA, a pushed branch such as `guillermo/slugify-should-also-strip-punctuation…`, and a PR URL.

Useful flags (full list with `npm run cli -- --help`):

| Flag | Meaning |
| --- | --- |
| `--repo <path>` | Repository to change (required) |
| `--task <text>` | What to do (required) |
| `--branch <name>` | Name for the new working branch (default: derived from the task); existing names are refused |
| `--base <branch>` | Pull-request base branch (default: the branch you started on) |
| `--pr-title <text>` | Pull-request title (default: derived from the task) |
| `--model <id>` | Override `GUILLERMO_MODEL` |
| `--max-steps <1-50>` | Cap on tool-call steps (default 20) |

### 2.4 What happens to your repository

- The working tree must be clean and the working branch must not already exist, or Guillermo exits before changing anything.
- It creates a new branch from your current commit and **leaves it checked out** afterwards.
- It commits, pushes and opens a PR only if the agent called `finish`, changed at least one file, and at least one `run_tests` call passed. Otherwise your edits remain in the working tree on the new branch and the report explains why nothing was published.
- Publishing needs `origin` to be a GitHub repository and an authenticated `gh`. It never force-pushes.

To discard a run: `git checkout main && git branch -D <branch>` (and `git checkout -- . && git clean -fd` if it left uncommitted changes).

## 3. Run the webhook service locally

The webhook service is what a Jira comment triggers. Locally it listens on `127.0.0.1:3000` by default.

### 3.1 Smoke test with placeholder credentials (no Jira, no GitHub App)

This is the quickest way to see the HTTP layer, authentication, job lifecycle logging and Docker readiness check working. The GitHub App key is only read when a job actually starts, so placeholders are enough to start the server; the job itself will fail at that point, and that is the expected outcome.

1. Build the worker image (the server refuses to start without it, and it has no host-execution fallback):

   ```bash
   npm run docker:build
   ```

2. Edit `.env`. These values are sufficient for the smoke test:

   ```dotenv
   OPENAI_API_KEY=sk-placeholder-or-real
   GUILLERMO_JIRA_WEBHOOK_SECRET=local-dev-secret-0123456789
   GUILLERMO_JIRA_PROJECTS={"APP":{"repository":"my-org/app","baseBranch":"main"}}
   GUILLERMO_GITHUB_APP_ID=1
   GUILLERMO_GITHUB_APP_INSTALLATION_ID=2
   GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH=/absolute/path/that/does/not/exist.pem
   GUILLERMO_GIT_AUTHOR_NAME=Guillermo Bot
   GUILLERMO_GIT_AUTHOR_EMAIL=guillermo-bot@example.com
   GUILLERMO_WORKSPACE_ROOT=/absolute/path/to/an/empty/directory
   ```

   `GUILLERMO_WORKSPACE_ROOT` must be a normalized absolute path (no trailing slash, no `..`). Create a directory such as `mkdir -p "$HOME/guillermo-workspaces"` and use its absolute path. The webhook secret must be at least 16 bytes.

3. Start the server in one terminal:

   ```bash
   npm run dev
   ```

   You should see `"event":"listening"`. If you see an error instead, check [Troubleshooting](#troubleshooting).

4. In another terminal:

   ```bash
   # Health check: {"status":"ok"}
   curl -i http://127.0.0.1:3000/healthz

   # No secret header → 401
   curl -i -X POST http://127.0.0.1:3000/webhooks/jira \
     -H 'Content-Type: application/json' -d '{}'

   # Valid trigger → 202 {"status":"accepted"}
   curl -i -X POST http://127.0.0.1:3000/webhooks/jira \
     -H 'Content-Type: application/json' \
     -H 'X-Guillermo-Webhook-Secret: local-dev-secret-0123456789' \
     --data '{"webhookEvent":"comment_created","issue":{"key":"APP-42","fields":{"project":{"key":"APP"},"summary":"Handle encoded URLs","description":"Preserve query strings."}},"comment":{"id":"9001","body":"/guillermo"}}'
   ```

   In the server terminal you will see `rejected`, then `accepted` and `started`, and — with placeholder credentials — a terminal `failed` record with `reasonCode: "job_runner_exception"`. That proves the request path works; the job failed because there is no real GitHub App key. See [jira-webhook.md](jira-webhook.md#job-events) for what each log event means.

### 3.2 Run a real end-to-end job

To go beyond the smoke test you need:

1. A **GitHub App** installed on a repository you control, with the private key saved to a file. Permissions and steps: [jira-webhook.md](jira-webhook.md#github-app-setup). Set the three `GUILLERMO_GITHUB_APP_*` variables with real values.
2. A repository containing `package.json` **and a committed `package-lock.json`**, whose `npm test` passes in a clean container (the sandbox repository from section 2.2 qualifies once you have installed the GitHub App on it). Map a Jira project key to it in `GUILLERMO_JIRA_PROJECTS`.
3. A way to deliver the webhook. Either keep using `curl` as above (simplest — no Jira needed), or expose the local port through an HTTPS tunnel and configure a Jira Automation rule ([jira-webhook.md](jira-webhook.md#configure-jira-automation)).

Then send the trigger. The `202` returns immediately; follow the JSON logs for `completed` and a pull request on GitHub.

### 3.3 Running the compiled build

```bash
npm run build
npm start          # node dist/index.js, same behaviour as npm run dev
```

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| `OPENAI_API_KEY is required` | `.env` is missing or you ran from a different directory. `.env` is read from the current working directory; run commands from the repo root or export the variable. |
| `Missing required option: --repo` / `--task` | Both flags are required; quote the task string. |
| Run exits immediately with a dirty-tree message | Commit or stash changes in the target repository. |
| `GUILLERMO_JIRA_PROJECTS must be valid JSON` | The value must be a single line of JSON with double quotes. Don't wrap it in extra quotes in `.env`. |
| `GUILLERMO_WORKSPACE_ROOT must be a normalized absolute directory path…` | Use an absolute path with no trailing slash, `..`, or commas. |
| `GUILLERMO_JIRA_WEBHOOK_SECRET must be at least 16 bytes` | Use a longer random value, e.g. `openssl rand -hex 24`. |
| Server fails at startup with a Docker error | Start Docker, then run `npm run docker:build`. Check that `docker image inspect guillermo-worker:latest` succeeds or that `GUILLERMO_DOCKER_IMAGE` names an image that exists locally (images are never pulled automatically). |
| `401` on a webhook call | Header must be exactly `X-Guillermo-Webhook-Secret` with the configured value. |
| `202` but the job logs `failed` / `job_runner_exception` | Expected with placeholder GitHub App values. With real values, check the key path is absolute and readable, and that the App is installed on the repository named in `GUILLERMO_JIRA_PROJECTS`. |
| `completed` with `skipped` and a `reasonCode` | The job ran but did not meet the publishing rules; see the reason-code table in the [runbook](../deploy/aws/RUNBOOK.md#job-event-lifecycle-and-schema). |
| `gh: command not found` or authentication errors in CLI mode | Install the GitHub CLI and run `gh auth login`. The agent's local branch and edits are not lost; the report states why publishing was skipped. |
| `npm test` shows 1 skipped | Expected. See section 1 to enable the Docker test. |
