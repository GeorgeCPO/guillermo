# Guillermo

Guillermo is a small coding agent written in TypeScript to explore one question: **how can an LLM change a real repository safely and transparently?**

Given a task, it reads and edits a Git repository through a handful of narrow tools, runs the project's tests, and opens a GitHub pull request. It runs in two modes:

| Mode | Trigger | Credentials | Isolation |
| --- | --- | --- | --- |
| **Local CLI** | You run `npm run cli` against a checkout on your machine | Your `gh` login | None beyond the tool restrictions below |
| **Jira webhook service** | A Jira comment that is exactly `/guillermo` | A GitHub App (no personal account) | Fresh clone per job; repository code runs only in throw-away Docker containers |

> **Project status.** This is a learning project, built in numbered stages (the "Stage 9", "Stage 10" labels you will see in code comments and the AWS runbook). It is not production software: jobs are held in memory, there are no retries, and the Docker boundary is not a hostile-code boundary. See [Limitations](#limitations).

## How it works

```
 task ──► agent loop (OpenAI Responses API, max N steps)
              │  structured tool calls only
              ▼
   list_files · read_file · search_repository · apply_patch · run_tests · finish
              │
              ▼  after `finish` + ≥1 changed file + ≥1 passing test run
   commit ──► push NEW branch ──► pull request into the starting branch
```

- **Six tools, no shell.** The model can list files, read files, search for literal text, apply a validated unified diff, run an allow-listed test command (`npm`/`pnpm`/`yarn`/`bun` `test`, no shell operators), and finish. Patches are limited to repository-relative text files and cannot touch `.env`, `.git`, `node_modules` or lockfiles.
- **TypeScript owns the control flow.** Prompts live in source, the model only returns structured tool calls, and publishing is gated by code, not by the model's say-so.
- **Never overwrites.** The agent works on a new branch, refuses a dirty working tree, and never force-pushes.

## Quick start

You need **Node.js 22+**. The first steps need no API keys, so you can confirm the project builds and its tests pass before configuring anything.

```bash
git clone <this-repository-url> guillermo && cd guillermo
npm install
npm run check   # type-check source and tests
npm test        # 113 tests; the live Docker test is skipped unless enabled
```

To run the agent itself you also need an OpenAI API key:

```bash
cp .env.example .env     # then set OPENAI_API_KEY in .env
npm run cli -- --help
npm run cli -- --repo /absolute/path/to/a/repository --task "Add a test for the URL parser"
```

The CLI publishes through the GitHub CLI (`gh auth login`) and needs the target repository's `origin` to be on GitHub. **[docs/local-setup.md](docs/local-setup.md)** is the full walkthrough: prerequisites, a disposable sandbox repository to practise on, the webhook service on your laptop with no real Jira or GitHub App, and troubleshooting.

## Documentation

| Document | Read it for |
| --- | --- |
| [docs/local-setup.md](docs/local-setup.md) | Installing, running tests, running the CLI and the webhook server locally, troubleshooting |
| [docs/configuration.md](docs/configuration.md) | Every environment variable and CLI flag, with defaults and validation rules |
| [docs/jira-webhook.md](docs/jira-webhook.md) | The Jira trigger, request format, GitHub App permissions, job lifecycle |
| [docs/security-model.md](docs/security-model.md) | Trust boundaries, Docker worker hardening, and what is deliberately *not* protected |
| [deploy/aws/RUNBOOK.md](deploy/aws/RUNBOOK.md) | Deploying to a single EC2 host with Terraform, ECR, SSM and CloudWatch Logs, plus the log schema |

## Repository layout

```
src/
  entrypoints/cli/      CLI argument parsing and report rendering
  entrypoints/http/     Fastify server, /webhooks/jira and /healthz routes, graceful shutdown
  application/          Orchestration: run, remote job, job queue, workspaces, job observability
  agent/                The tool-calling loop and tool definitions
  repository/           Repository access and path safety rules used by the tools
  integrations/         GitHub (App auth, REST PRs, gh CLI) and Jira (payload validation)
  infrastructure/       Git client, process runner, Docker sandbox, environment scrubbing
  config/               Environment parsing and validation
tests/unit, tests/integration   node:test suites (integration tests spawn real processes/Docker)
deploy/aws/             Terraform, release scripts and runbook for a single-EC2 AWS deployment
Dockerfile.worker       Throw-away container image for repository-controlled commands
Dockerfile.coordinator  Image for the long-running webhook service
```

## Limitations

- **Publishing is conservative.** A pull request is created only after `finish`, at least one changed file and at least one passing `run_tests` result. Otherwise nothing is committed or pushed and the report says why. Test commands that modify tracked files confuse the "what did the agent change" calculation, so keep them side-effect free.
- **State is in memory.** Webhook deduplication and per-repository queues are lost on restart. There are no durable jobs, retries, approvals or Jira status updates.
- **Docker is not a perfect boundary.** `npm ci` needs outbound network access in the worker; tests run with `--network none`. Private registries and non-npm projects are unsupported for webhook jobs.
- **npm only for unattended jobs.** Webhook jobs require `package.json` plus a committed `package-lock.json`.
- **Single instance.** The AWS deployment is one EC2 host with brief downtime on every release.

More detail, including the threat-model reasoning, is in [docs/security-model.md](docs/security-model.md).

## Contributing and security

Issues and review comments are welcome. Please do not include secrets, private keys or real Jira payloads in them. For a suspected vulnerability, use GitHub's private vulnerability reporting for this repository rather than a public issue.
