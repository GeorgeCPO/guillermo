# Security model

This document explains who and what Guillermo trusts, which controls exist, and where it is honest about gaps. It is the best place to start if you are reviewing the project from a security angle. Operational limits specific to the AWS deployment are listed at the end of the [runbook](../deploy/aws/RUNBOOK.md#security-and-disaster-recovery-limits-before-stage-11).

## Trust boundaries

| Component | Trusted? | Holds |
| --- | --- | --- |
| **Coordinator** (the Node process: HTTP server, queue, agent loop, Git and GitHub calls) | Yes | OpenAI key, GitHub App key and tokens, webhook secret |
| **Jira webhook request** | No | Validated and reduced to issue key, project key, summary, description |
| **Target repository content** (code, scripts, `package.json` lifecycle hooks, tests) | No | — |
| **The LLM's output** | No | Treated as a request to run one of six tools, validated by code |
| **Worker container** | No | A writable checkout and a fixed non-secret environment only |

The design rule: the coordinator never executes anything controlled by the repository or the model on the host. Repository-controlled execution crosses into a worker container; model output is only ever interpreted as structured tool calls.

## Controls by layer

### Webhook input

- Shared-secret header checked before the body is parsed; wrong or missing secret returns `401`.
- Body limit of 256,000 bytes, content-type and schema validation.
- Exact-match trigger (`/guillermo`); no free-form instruction text reaches the model from the comment.
- Repository, branch, PR title format and every other parameter come from the server-side allowlist, not the request.
- Request bodies and the secret header are redacted from logs; request logging is disabled.

### Agent tools

- No general shell. The model has `list_files`, `read_file`, `search_repository`, `apply_patch`, `run_tests`, `finish`.
- Paths are repository-relative and resolved against the repository root; sensitive paths (`.env`, `.git`, `node_modules`, lockfiles) are blocked for patching and search.
- `run_tests` accepts only `npm`, `pnpm`, `yarn` or `bun` test commands without shell operators. Webhook jobs additionally accept only `npm`.
- Publishing requires `finish`, at least one changed file and at least one passing test run.

### Git and GitHub

- A new branch per run; existing branches are never overwritten and nothing is force-pushed. If `HEAD` moved, the working branch changed, or `origin` no longer matches the allowlisted repository, publication is refused.
- Webhook jobs use a GitHub App installation token scoped to `contents: write` and `pull_requests: write`. The token is never in a URL, argument, config file, log or report; Git receives it through a short-lived askpass helper that is deleted with the workspace.
- The environment passed to child processes is scrubbed (`src/infrastructure/process/safe-environment.ts`).

### Docker workers

- A fresh container per command, removed on exit; timeouts, cancellations and output-limit breaches force-remove it by name.
- Only the current checkout is mounted, with `.git` over-mounted read-only so scripts cannot plant hooks or alter Git config.
- Non-root UID/GID, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, and CPU, memory, PID, output and time limits.
- `npm ci`: default bridge network (needs the registry). Tests: `--network none`.
- Nothing sensitive is ever mounted: no Docker socket, GitHub App key, askpass helper, other workspace, or coordinator environment.
- `--pull never`: image acquisition cannot be triggered by an incoming webhook. The server verifies the Docker daemon and image before it starts listening and has no host-execution fallback.

### AWS deployment

- No SSH and no key pair; administration is via Systems Manager.
- ALB accepts only HTTPS on 443 from configured Atlassian CIDR ranges and forwards only `POST /webhooks/jira`; the instance accepts port 3000 only from the ALB.
- IMDSv2 with hop limit 1, plus a firewall rule rejecting worker traffic to `169.254.169.254`.
- Secrets live in Secrets Manager, are never Terraform inputs, and are materialised on encrypted EBS in `0440` files at deploy time. Images are immutable ECR tags pinned to the commit SHA.
- Logs are structured and sanitised; they contain Jira issue/project keys and counters but no bodies, prompts, diffs, repository names or errors.

## Known gaps

These are deliberate scope limits, not oversights:

- **Docker is not a hostile-code boundary.** A kernel or runtime escape would reach the host. Keep Docker, kernel and base images patched.
- **The coordinator has Docker-socket authority**, which is effectively root on its host. Run it on a dedicated host.
- **`npm ci` has open egress.** A malicious dependency lifecycle script can reach any internet destination available from the bridge network and exfiltrate the checkout contents. There is no proxy, domain allowlist or private mirror.
- **Prompt injection is mitigated, not solved.** The model reads repository files and the Jira summary/description, which an attacker with access to those could shape. The limiting factors are the narrow tools, the clean-branch-only publishing, and the fact that a human must still review and merge the pull request.
- **Single shared secret** authenticates Jira. There is no WAF, rate limiting or request signing.
- **No durability.** Jobs, deduplication state and queues are in memory; a restart or the 30-second shutdown window can drop in-flight work.
- **The local CLI has no sandbox.** `run_tests` executes the target repository's test command directly on your machine, so only point it at repositories whose tests you would run yourself.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository rather than a public issue, and do not include real credentials or customer data.
