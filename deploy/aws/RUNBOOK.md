# Guillermo Stage 10.5: single-EC2 deployment and CloudWatch Logs runbook

This runbook deploys one dedicated Amazon Linux 2023 EC2 host, one persistent trusted coordinator container, and ephemeral worker containers. Terraform creates the EC2, IAM, ECR, ALB, security-group, target-group, CloudWatch log group, and optional Route 53 resources. It does not create or read secret values.

The coordinator writes the same sanitized JSON records to stdout/stderr as before. Docker's built-in `awslogs` driver sends those records to CloudWatch Logs. The Docker daemon obtains the narrowly scoped EC2 role credentials on the host; credentials are not injected into the coordinator or workers. The existing container-to-IMDS firewall rule remains in place.

## 1. Prerequisites and costs

You need:

- an AWS account and AWS CLI credentials allowed to manage EC2, IAM, ECR, ELBv2, Systems Manager, and optionally Route 53;
- Terraform 1.6 or newer, Docker with Buildx, AWS CLI v2, `jq`, and Git;
- an existing VPC, two public subnets in different Availability Zones for the ALB, and an EC2 subnet with outbound internet access (normally a private subnet through NAT);
- a domain name and an ACM certificate in the deployment region covering the chosen hostname;
- a GitHub App installed only on the repositories Guillermo may change; and
- Jira Automation, because the Jira webhook request must include a custom secret header.

Costs normally include the continuously running EC2 instance, gp3 EBS volume, Application Load Balancer and LCUs, NAT gateway and data processing if used, public IPv4 if your VPC design uses one, Secrets Manager secrets/API calls, ECR storage/scanning, CloudWatch Logs ingestion/storage/query scanning, data transfer, and optional Route 53 hosted-zone/query charges. Review current AWS pricing for the selected region before applying.

The EC2 instance is a dedicated Guillermo host. Docker-socket access lets the coordinator control the host Docker daemon and is effectively host-root authority despite the coordinator's non-root Linux UID.

## 2. Certificate, DNS, and network prerequisites

Request or import an ACM certificate in the same region as the ALB. Validate it before applying. The certificate must cover, for example, `guillermo.example.com`.

Always supply `dns_name`. If Route 53 hosts the domain, also supply `route53_hosted_zone_id` and Terraform creates an A alias. Otherwise leave only the zone ID empty and create a CNAME/alias with your DNS provider from the ALB DNS-name output visible in the AWS console. The browser/client hostname must match the ACM certificate.

The ALB subnets must be public and route to an internet gateway. The EC2 subnet does not need inbound internet access, a public IP, SSH, or a key pair, but it must reach AWS APIs, ECR, GitHub, OpenAI, package repositories, and npm. A NAT gateway is the simplest private-subnet design. VPC endpoints can reduce some NAT paths but do not replace internet access required by GitHub, OpenAI, and npm.

Keep `allowed_https_cidrs` synchronized with Atlassian's published summary IPv4 ranges for outgoing connections. These ranges are shared Atlassian infrastructure and can include user-configurable Forge traffic, so they supplement rather than replace the tenant-specific webhook secret. The ALB exposes only HTTPS port 443; port 3000 is allowed solely from the ALB security group, and port 22 is never opened.

## 3. Create secret values outside Terraform

Create two local files outside the repository. Do not paste secret values into Terraform variables, shell history, command arguments, tickets, or logs.

`/secure/path/guillermo-runtime.json` must be one JSON object with exactly this contract (additional keys are ignored):

```json
{
  "OPENAI_API_KEY": "...",
  "GUILLERMO_JIRA_WEBHOOK_SECRET": "a-random-secret-of-at-least-16-bytes",
  "GUILLERMO_JIRA_PROJECTS": {
    "APP": {
      "repository": "my-org/my-repository",
      "baseBranch": "main",
      "prTitleFormat": "[{issueKey}] {summary}"
    }
  },
  "GUILLERMO_GITHUB_APP_ID": "123456",
  "GUILLERMO_GITHUB_APP_INSTALLATION_ID": "789012",
  "GUILLERMO_GIT_AUTHOR_NAME": "Guillermo Bot",
  "GUILLERMO_GIT_AUTHOR_EMAIL": "guillermo-bot@example.com",
  "GUILLERMO_MAX_STEPS": "20"
}
```

`GUILLERMO_JIRA_PROJECTS` is a JSON object, not a string containing JSON. IDs are strings of decimal digits. All scalar values must be non-empty single lines. Protect the file with `chmod 600`.
`GUILLERMO_MAX_STEPS` is optional and must be a string containing an integer from `1` through `50`; when omitted, Guillermo uses its application default of `20`. Higher values allow longer jobs but can increase OpenAI usage, runtime, and cost.

The second file, `/secure/path/github-app-private-key.pem`, is the raw PEM downloaded from GitHub. It is the entire Secrets Manager `SecretString`, not JSON or base64. Protect it with `chmod 600`.

Create the secrets by file reference so values do not appear in arguments:

```bash
export AWS_REGION=eu-central-1
aws secretsmanager create-secret \
  --region "$AWS_REGION" \
  --name guillermo/runtime \
  --secret-string file:///secure/path/guillermo-runtime.json
aws secretsmanager create-secret \
  --region "$AWS_REGION" \
  --name guillermo/github-app-private-key \
  --secret-string file:///secure/path/github-app-private-key.pem
```

Record the two returned ARNs. If the secrets use customer-managed KMS keys, also record those exact key ARNs for `secret_kms_key_arns`. The EC2 policy grants `GetSecretValue` only to these two secret ARNs and conditional `kms:Decrypt` only to those keys through Secrets Manager.

## 4. Configure and apply Terraform

Use a remote encrypted Terraform backend with locking for a team deployment; backend configuration is intentionally account-specific. Secret values are never Terraform inputs or data sources. Only secret ARNs enter state.

```bash
cd deploy/aws/terraform
cp terraform.tfvars.example terraform.tfvars
```

Set these required inputs:

- `aws_region`
- `vpc_id`
- `alb_public_subnet_ids` (at least two, in distinct AZs)
- `ec2_subnet_id`
- `instance_type` and matching `instance_architecture` (`x86_64` or `arm64`)
- `acm_certificate_arn`
- `allowed_https_cidrs`
- `runtime_secret_arn`
- `github_private_key_secret_arn`
- `release_tag` (normally the full Git commit SHA, never `latest`)
- required `dns_name`; optional `route53_hosted_zone_id` when that name is hosted in Route 53
- optional exact `secret_kms_key_arns` and `ecr_kms_key_arn`
- optional `coordinator_log_group_name` (default `/guillermo/coordinator`), `coordinator_log_retention_days` (default `30`), and `coordinator_log_group_skip_destroy` (default `true`);
- optional `cloudwatch_logs_kms_key_arn`; leave it empty for CloudWatch's server-side AES-256 encryption, which encrypts every log group at rest without another key to operate; and
- optional ECR repository names, root volume size, and tags.

Thirty days is a sensible starting retention period: it normally covers incident investigation without retaining operational metadata indefinitely. CloudWatch automatically expires older events. Changing retention affects future expiry but does not restart the application.

If your organization requires a customer-managed KMS key, the key must be symmetric, in `eu-central-1`, and its key policy must permit the regional `logs.eu-central-1.amazonaws.com` service principal for this exact log-group encryption context. The EC2 role receives KMS use only for the configured key and only through `logs.eu-central-1.amazonaws.com`. The Terraform operator also needs permission to describe/associate that key. A disabled, deleted, or incorrectly configured key prevents ingestion and can make previously encrypted logs unreadable, so the default service-managed encryption is the lower-maintenance choice for most small deployments.

Then format, initialize, validate, inspect, and apply:

```bash
terraform fmt -check -recursive
terraform init
terraform validate
terraform plan -out=guillermo.tfplan
terraform show guillermo.tfplan
terraform apply guillermo.tfplan
```

The first bootstrap may report that images are unavailable because Terraform creates empty repositories and the instance together. This is expected. Bootstrap still installs all host services and remains deployable through SSM.

Capture outputs:

```bash
export AWS_REGION=eu-central-1
export COORDINATOR_ECR_REPOSITORY_URL=$(terraform output -raw coordinator_ecr_repository_url)
export WORKER_ECR_REPOSITORY_URL=$(terraform output -raw worker_ecr_repository_url)
export INSTANCE_ID=$(terraform output -raw instance_id)
export HTTPS_ENDPOINT=$(terraform output -raw https_endpoint)
export RELEASE_TAG=$(terraform output -raw release_tag)
export COORDINATOR_LOG_GROUP_NAME=$(terraform output -raw coordinator_log_group_name)
```

## 5. Build and publish the immutable release

Run from the repository root with a committed, clean tree. Match `TARGET_ARCH` to Terraform. The script verifies tools, the Git state, AWS identity, region/account ownership of both ECR URLs, and repository existence; it logs in with a short-lived ECR token via standard input. It never uses `latest`.

```bash
cd ../../..
export TARGET_ARCH=x86_64
./deploy/aws/build-and-push.sh
```

The script pushes both images as `<repository-url>:<release-tag>` and writes the exact Compose-compatible references to `/tmp/guillermo-release-<tag>.env`. ECR tags are immutable; a second push to the same tag fails by design.

## 6. Deploy through Systems Manager

The host utility reauthenticates to ECR using the instance role, refreshes both secrets into root-owned/group-readable `0440` files, pulls both exact images, validates Compose, and restarts systemd. Secret values and Secrets Manager responses are never printed.

Compose maps `GUILLERMO_DOCKER_SOCKET_PATH` on the host to `/var/run/docker.sock` in the coordinator and honors the container-side `DOCKER_HOST`. This keeps a future rootless-daemon socket swappable without changing the image; update the non-secret host settings and systemd Docker client endpoint together when performing that migration.

```bash
export AWS_REGION=eu-central-1
export INSTANCE_ID=i-0123456789abcdef0
export RELEASE_TAG=$(git rev-parse HEAD)
./deploy/aws/deploy-via-ssm.sh
```

No SSH connection or key is involved. On reboot, `guillermo.service` starts the already selected release through Docker Compose.

### Updating trusted host assets on an existing instance

Terraform deliberately ignores in-place EC2 `user_data_base64` changes because cloud-init is create-time bootstrap. Therefore, applying the log-group and IAM changes does **not** replace the current instance and does **not** copy the new Compose/scripts onto it. After the Terraform apply succeeds, run the source-controlled asset updater once:

```bash
cd <repository-root>
export AWS_REGION=eu-central-1
export INSTANCE_ID=i-006a8c635d7ce0256
export RELEASE_TAG=1d3631ddfed6edf40bf2c908cb1096818e75afb9
export COORDINATOR_LOG_GROUP_NAME=$(cd deploy/aws/terraform && terraform output -raw coordinator_log_group_name)
./deploy/aws/update-host-assets-via-ssm.sh
```

The updater packages only four reviewed source files, verifies a SHA-256 checksum on the host, atomically installs them, adds the non-secret log-group name to `/etc/guillermo/deployment.conf`, and invokes the existing immutable release. It refreshes secrets into protected files without printing them, pulls the already-published images, validates Compose, and recreates the coordinator. It does not build or push an image, manually edit a host file, use SSH, change worker mounts/environment, or change Terraform state. Re-running the same command is safe and converges to the same files/release, but it causes another brief coordinator restart.

Infrastructure must be applied first. Otherwise Docker cannot find the Terraform-managed group or use the new IAM permission, and the recreated container might not start. If the command fails, inspect its SSM status and retry after correcting the cause; do not paste secret material into an SSM command.

## 7. Verify health and configure Jira

Wait for the target to become healthy. The ALB calls `/healthz` directly on the target group, but the public listener intentionally forwards only `POST /webhooks/jira`; any other request that passes the security-group allowlist receives the listener's fixed `404` response. Requests from outside the Atlassian CIDRs are dropped before reaching the listener.

```bash
aws elbv2 describe-target-health \
  --region "$AWS_REGION" \
  --target-group-arn "$(cd deploy/aws/terraform && terraform output -raw target_group_arn)"

aws ssm send-command \
  --region "$AWS_REGION" \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters 'commands=["curl --fail --silent --show-error http://127.0.0.1:3000/healthz"]'
```

Target health must be `healthy`; the local health body must be exactly `{"status":"ok"}` (JSON whitespace aside). It intentionally contains no project, job, repository, Docker, workspace, or configuration details.

In Jira Automation, create a rule for comment creation and a **Send web request** action:

- URL: `<HTTPS_ENDPOINT>/webhooks/jira`
- method: `POST`
- header: `Content-Type: application/json`
- header: `X-Guillermo-Webhook-Secret: <the configured webhook secret>`
- body: the Jira webhook JSON containing `webhookEvent`, issue fields, and comment.

Do not put the secret in the URL. A comment whose entire text is `/guillermo` should receive HTTP 202 and enqueue the in-memory job.

## 8. Administration and logs

### Find the logs in the AWS console

1. Sign in to the AWS console and select **Frankfurt (`eu-central-1`)** in the region selector.
2. Open **CloudWatch**.
3. In the left navigation, choose **Logs** → **Log groups**.
4. Choose `/guillermo/coordinator` (or the value of Terraform output `coordinator_log_group_name`).
5. Choose a stream named `coordinator-<immutable-release-tag>`. Each release has a predictable stream, so a rollback returns to its earlier stream.

The log group is independent of the EC2 root disk. Replacing or destroying the instance does not erase ingested CloudWatch events. A replacement coordinator continues into the stream selected by its immutable release tag. There may be a short gap for lines that were still buffered locally when the old instance disappeared.

### Job event lifecycle and schema

One accepted job normally produces this sequence:

| Event | Meaning | Terminal? |
| --- | --- | --- |
| `accepted` | The authenticated Jira event passed validation and was added to the in-memory queue. The HTTP request has already received `202`. | No |
| `started` | The job has left the repository queue and its runner is executing. This is Guillermo's running state. | No |
| `completed` | The runner returned a normal result. Inspect `outcome`: `created`, `skipped`, or `failed`. A skipped or failed publication still completed normally as a job. | Yes |
| `failed` | The runner threw unexpectedly—for example, workspace preparation failed—instead of returning an agent/publication result. It has `reasonCode: "job_runner_exception"` and no matching `completed` record. | Yes |

`duplicate` means the same event ID was already active, and `rejected` means the request was invalid, unauthenticated, unsupported, or not a trigger. They are request events, not running jobs.

All job lifecycle records contain `eventId` and, for Jira work, `issueKey` and `projectKey`. A `completed` record also contains:

| Field | Meaning |
| --- | --- |
| `outcome` | `created`, `skipped`, or `failed` pull-request outcome. |
| `reasonCode` | Stable machine-readable reason for `skipped` and `failed`; absent for `created`. |
| `agentTermination` | `finished`, `step_limit`, `stopped`, or `failed`. |
| `agentStepCount` | Number of model response cycles attempted. This is not a token count. |
| `changedFileCount` | Number of changed paths reported by the agent. Paths themselves are excluded. |
| `testRunCount` | Number of `run_tests` calls recorded by the agent. |
| `successfulTestRunCount` | Test runs whose command exited with code zero. |
| `durationMs` | Monotonic elapsed time from `started` until the terminal result, rounded to whole milliseconds. Queue waiting time is excluded. |

An unexpected `failed` record has `outcome: "failed"`, `reasonCode: "job_runner_exception"`, a coarse safe `exceptionType` (`type_error`, `range_error`, `error`, or `unknown`), and `durationMs`. It omits agent counters because the runner did not return a trustworthy report. Exception messages and names are not logged.

Reason codes are assigned at the decision that produced the result; Guillermo never infers them by parsing the human-readable CLI reason.

| Reason code | Meaning | First diagnostic action |
| --- | --- | --- |
| `agent_step_limit` | The agent used all configured steps without calling `finish`. | Compare `agentStepCount` with `GUILLERMO_MAX_STEPS`; inspect whether the task may be too broad. |
| `agent_failed` | Agent execution raised an error before finishing. | Look for infrastructure/API availability around the same timestamp; raw errors are intentionally absent. |
| `agent_stopped` | The model returned without a valid `finish` call. | Retry only after deciding whether the task or model behavior needs adjustment. |
| `no_files_changed` | The agent finished but reported zero changed files. | Confirm the request actually requires a code change. |
| `no_successful_test_run` | No recorded `run_tests` call exited successfully. | Compare `testRunCount` and `successfulTestRunCount`; command output is intentionally absent. |
| `remote_branch_exists` | The configured working branch already exists remotely. | Check for a prior delivery/run of the same Jira event. Guillermo will not overwrite it. |
| `working_branch_changed` | The checkout was no longer on the branch created for this run. | Treat as a repository safety refusal; inspect the repository's scripts outside production logs. |
| `head_changed` | `HEAD` moved after Guillermo created the working branch. | Check whether a repository command made a commit; Guillermo refuses to add another. |
| `no_uncommitted_files` | Changes reported earlier were no longer present when publication began. | Check whether repository tooling reverted, committed, or removed them. |
| `git_origin_changed` | The managed checkout's fetch or push origin no longer matched the allowlisted repository. | Treat as a safety event and inspect repository setup/scripts; no credentials were acquired for publication. |
| `publication_failed` | Commit, push, authentication, or GitHub PR creation failed without a safer public classification. | Check GitHub/App availability and permissions. Detailed command/API messages are not in job logs. |
| `job_runner_exception` | The job runner threw before returning a normal result. | Correlate coordinator/platform logs by timestamp; the next queued job still runs. |

Sanitized examples (Pino also adds fields such as `level`, `time`, `pid`, and `hostname`):

```json
{"event":"accepted","eventId":"KAN-3:comment:10071","issueKey":"KAN-3","projectKey":"KAN"}
{"event":"started","eventId":"KAN-3:comment:10071","issueKey":"KAN-3","projectKey":"KAN"}
{"event":"completed","eventId":"KAN-3:comment:10071","issueKey":"KAN-3","projectKey":"KAN","outcome":"skipped","reasonCode":"agent_step_limit","agentTermination":"step_limit","agentStepCount":20,"changedFileCount":2,"testRunCount":1,"successfulTestRunCount":1,"durationMs":184321}
```

```json
{"event":"completed","eventId":"KAN-4:comment:10072","issueKey":"KAN-4","projectKey":"KAN","outcome":"created","agentTermination":"finished","agentStepCount":8,"changedFileCount":4,"testRunCount":2,"successfulTestRunCount":2,"durationMs":92110}
{"event":"completed","eventId":"KAN-5:comment:10073","issueKey":"KAN-5","projectKey":"KAN","outcome":"failed","reasonCode":"publication_failed","agentTermination":"finished","agentStepCount":9,"changedFileCount":3,"testRunCount":1,"successfulTestRunCount":1,"durationMs":101442}
{"event":"failed","eventId":"KAN-6:comment:10074","issueKey":"KAN-6","projectKey":"KAN","outcome":"failed","reasonCode":"job_runner_exception","exceptionType":"error","durationMs":812}
```

There is exactly one terminal job event: `completed` when the runner returns, or `failed` when it throws. Do not expect both for one execution.

### View, follow, and filter with the AWS CLI

These commands use your operator's AWS CLI identity, not the EC2 role. That identity needs read-only CloudWatch Logs permissions.

```bash
export AWS_REGION=eu-central-1
export LOG_GROUP=/guillermo/coordinator

# Recent records, oldest to newest.
aws logs tail "$LOG_GROUP" --region "$AWS_REGION" --since 1h --format short

# Follow new records until Ctrl-C.
aws logs tail "$LOG_GROUP" --region "$AWS_REGION" --since 10m --follow --format short
```

To fetch the last 24 hours as JSON and filter the embedded application records with `jq`:

```bash
START_MS=$(( ($(date +%s) - 86400) * 1000 ))
aws logs filter-log-events \
  --region "$AWS_REGION" \
  --log-group-name "$LOG_GROUP" \
  --start-time "$START_MS" \
  --output json \
| jq -c '.events[].message | fromjson | select(.event == "accepted" or .event == "started" or .event == "completed" or .event == "failed")'
```

Useful `jq` filters against that same stream are:

```bash
# Every lifecycle event for one Jira issue.
sudo docker logs guillermo-coordinator 2>&1 \
  | jq -Rrc 'fromjson? | select(.issueKey == "KAN-3")'

# One exact webhook delivery/job.
sudo docker logs guillermo-coordinator 2>&1 \
  | jq -Rrc 'fromjson? | select(.eventId == "KAN-3:comment:10071")'

# Step-limit and test eligibility skips.
sudo docker logs guillermo-coordinator 2>&1 \
  | jq -Rrc 'fromjson? | select(.reasonCode == "agent_step_limit" or .reasonCode == "no_successful_test_run")'

# Publication failures and unexpected runner exceptions.
sudo docker logs guillermo-coordinator 2>&1 \
  | jq -Rrc 'fromjson? | select(.reasonCode == "publication_failed" or .reasonCode == "job_runner_exception")'
```

Run these local-cache commands inside the authenticated Session Manager shell described below. `fromjson?` safely ignores any non-JSON Docker diagnostic lines.

In **CloudWatch Logs Insights**, select the coordinator log group. To inspect recent jobs:

```text
fields @timestamp, event, eventId, issueKey, projectKey, outcome, reasonCode,
  agentTermination, agentStepCount, changedFileCount, testRunCount,
  successfulTestRunCount, durationMs, exceptionType
| filter event in ["accepted", "started", "completed", "failed"]
| sort @timestamp desc
| limit 200
```

Find one issue or exact event:

```text
fields @timestamp, event, eventId, outcome, reasonCode, agentTermination, agentStepCount,
  testRunCount, successfulTestRunCount, durationMs
| filter issueKey = "KAN-3"
| sort @timestamp asc
```

```text
fields @timestamp, event, outcome, reasonCode, agentTermination, agentStepCount,
  changedFileCount, testRunCount, successfulTestRunCount, durationMs, exceptionType
| filter eventId = "KAN-3:comment:10071"
| sort @timestamp asc
```

Find the main failure classes:

```text
fields @timestamp, eventId, issueKey, reasonCode, agentStepCount,
  testRunCount, successfulTestRunCount, durationMs, exceptionType
| filter reasonCode in ["agent_step_limit", "no_successful_test_run", "publication_failed", "job_runner_exception"]
| sort @timestamp desc
| limit 200
```

Application request logging remains disabled. Logs exclude webhook bodies, issue summaries/descriptions, comments, repository identities and URLs, branches, paths, diffs, test commands/output, prompts/responses, environment variables, secret headers, API keys, private keys, installation tokens, Secrets Manager responses, and arbitrary errors. Pull-request URLs are also excluded. Logs do contain operational Jira metadata (`eventId`, `issueKey`, and `projectKey`), timestamps, counts, and state codes. Treat the log group as sensitive operational data and grant read access accordingly.

### Local troubleshooting cache and outage behavior

The `awslogs` driver uses non-blocking delivery with a bounded 4 MB in-memory buffer. A slow or unavailable CloudWatch endpoint therefore cannot block the running Node process. When the buffer fills, Docker drops newer log records rather than stopping the coordinator. Docker dual logging also keeps a compressed, rotating local cache (at most five 10 MB files before compression), so `docker logs` remains useful during ordinary troubleshooting. The local cache is not a durable second copy and can also miss records during remote/network failures.

Stream creation is permitted only under this Terraform-managed group and only with the `coordinator-` prefix. Docker is explicitly forbidden from creating log groups. At container creation time the driver must reach CloudWatch to create or reconnect to the stream; if CloudWatch, DNS, NAT, or IAM is unavailable at that moment, the container start can fail. The application is not crashed—it has not started. Restore connectivity/permissions and rerun the idempotent SSM deployment.

Start an authenticated Session Manager shell:

```bash
aws ssm start-session --region "$AWS_REGION" --target "$INSTANCE_ID"
```

Useful commands inside the session:

```bash
sudo cloud-init status --long
sudo journalctl -u cloud-init -u cloud-final --no-pager
sudo systemctl status guillermo guillermo-imds-block docker amazon-ssm-agent
sudo journalctl -u guillermo -n 200 --no-pager
sudo -u guillermo docker compose --env-file /etc/guillermo/host.env -f /opt/guillermo/compose.yaml ps
sudo docker logs --tail 200 guillermo-coordinator
sudo docker inspect --format '{{json .HostConfig.LogConfig}}' guillermo-coordinator
sudo journalctl -u docker -n 200 --no-pager
sudo iptables -w -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
```

Application request logging is disabled and structured job logs exclude bodies and credentials. Continue treating all operational logs as sensitive metadata.

Restart without changing the release:

```bash
sudo systemctl restart guillermo
```

If CloudWatch logs are missing:

1. Confirm the Terraform apply created the group and updated the instance role: `terraform state show aws_cloudwatch_log_group.coordinator` and `terraform state show aws_iam_role_policy.runtime`.
2. Confirm the exact region/group/stream options with the `docker inspect` command above. `awslogs-create-group` must be `false`, and the stream must begin `coordinator-`.
3. Confirm the coordinator is healthy and emitting records. Quiet periods legitimately produce no events.
4. Check `sudo journalctl -u docker` for `AccessDenied`, missing group, DNS, endpoint, NAT, or throttling errors. Never paste an environment dump or secret response into a ticket.
5. Confirm private-subnet egress reaches the regional CloudWatch Logs endpoint (`logs.eu-central-1.amazonaws.com`), either through the existing NAT path or a correctly secured `com.amazonaws.eu-central-1.logs` interface VPC endpoint.
6. For a customer-managed key, confirm it is enabled and both its policy and the conditional EC2 role permissions allow use through CloudWatch Logs for this group.
7. Retry `deploy-via-ssm.sh` with the same immutable release after repairing the issue. A full log backfill is not possible for records dropped after the bounded buffer filled.

### Retention and cost

The default `30`-day retention automatically removes older events. `coordinator_log_group_skip_destroy = true` does not override retention; it protects the group from stack destruction, not routine expiry. Longer retention increases stored bytes. CloudWatch Logs normally charges for ingestion and retained storage, and Logs Insights charges by data scanned; private-subnet traffic through a NAT gateway can add NAT processing charges. Sanitized low-volume coordinator logs should be modest, but failures or noisy dependencies can increase volume. Review the CloudWatch billing dashboard and current `eu-central-1` pricing before lengthening retention. This change intentionally adds no alarms, exports, subscriptions, or durable job storage.

## 9. Update and roll back

For an update, commit the desired source, choose that commit SHA as a new release tag, build/push both images, and run `deploy-via-ssm.sh` with the same tag. Coordinator and worker are always deployed as one release pair.

For a code-only release after committing, run these commands from the repository root. Set `TARGET_ARCH=arm64` instead if `instance_architecture` in Terraform is `arm64`. This does not run `terraform apply`, change secrets, or update host assets:

```bash
cd <repository-root>
test -z "$(git status --porcelain --untracked-files=normal)"

export AWS_REGION=eu-central-1
export TARGET_ARCH=x86_64
export RELEASE_TAG=$(git rev-parse HEAD)
export COORDINATOR_ECR_REPOSITORY_URL=$(cd deploy/aws/terraform && terraform output -raw coordinator_ecr_repository_url)
export WORKER_ECR_REPOSITORY_URL=$(cd deploy/aws/terraform && terraform output -raw worker_ecr_repository_url)
export INSTANCE_ID=$(cd deploy/aws/terraform && terraform output -raw instance_id)

./deploy/aws/build-and-push.sh
./deploy/aws/deploy-via-ssm.sh
```

The first script builds and pushes the coordinator and worker images under the full commit SHA. The second tells the existing host to pull that exact immutable pair and recreate the coordinator. Verify target health with the commands in section 7, then trigger a test Jira issue and query its `eventId`. Do not update Terraform's `release_tag` merely to deploy a code-only release; changing infrastructure state is a separate reviewed operation.

Rollback uses an earlier immutable tag already present in both repositories:

```bash
export RELEASE_TAG=<previous-commit-sha>
./deploy/aws/deploy-via-ssm.sh
```

There is a brief restart, not a zero-downtime rolling deployment: this architecture has one instance and one coordinator.

## 10. Rotate secrets and keys

Update the runtime JSON by file, never inline:

```bash
aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id <runtime-secret-arn> \
  --secret-string file:///secure/path/guillermo-runtime.json
```

For the GitHub App key, first create a new key in GitHub, then update the PEM secret by file. Redeploy the currently selected immutable tag to refresh materialized files, verify a job, and only then revoke the old GitHub key:

```bash
aws secretsmanager put-secret-value \
  --region "$AWS_REGION" \
  --secret-id <github-key-secret-arn> \
  --secret-string file:///secure/path/github-app-private-key.pem
./deploy/aws/deploy-via-ssm.sh
```

The host stores the current secret material on encrypted EBS as root-owned `0440` files with group `guillermo`. It is never baked into either image.

## 11. Clean workspace data

Normal jobs remove their unique workspace after completion. To clear abandoned workspace data, first stop the service and inspect the exact directory in a Session Manager shell:

```bash
sudo systemctl stop guillermo
sudo find /var/lib/guillermo/workspaces -mindepth 1 -maxdepth 1 -print
sudo find /var/lib/guillermo/workspaces -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo systemctl start guillermo
```

The delete command is irreversible. The directory is owned by UID/GID `10001:10001` (`guillermo:guillermo`) with mode `0750`. It is bind-mounted into the coordinator at the identical absolute path so host Docker can resolve worker bind mounts. Do not change one side independently.

## 12. Destroy

Review a destroy plan before running it:

```bash
cd deploy/aws/terraform
terraform plan -destroy -out=destroy.tfplan
terraform show destroy.tfplan
terraform apply destroy.tfplan
```

**Warning:** destroying infrastructure can remove the EC2 instance, its root EBS volume, load balancer, networking rules, IAM resources, DNS record, and other data. ECR has `force_delete = false`, so non-empty repositories deliberately block deletion until images are explicitly removed. The externally created Secrets Manager secrets are not Terraform-managed and remain until you deliberately delete them.

By default, `coordinator_log_group_skip_destroy = true`: Terraform removes the log group from state during destroy but deliberately leaves the group and retained events in CloudWatch. It then becomes an untracked AWS resource and continues to incur storage charges until retention removes its events or you deliberately manage/delete it. Before recreating the stack with the same group name, import it back into state:

```bash
terraform import aws_cloudwatch_log_group.coordinator /guillermo/coordinator
```

If you truly intend a future destroy to delete all CloudWatch coordinator logs, set `coordinator_log_group_skip_destroy = false`, review and apply that configuration change **before** creating the destroy plan, and verify the destroy plan lists the log group. Deletion is irreversible. A customer-managed KMS key is external and is never deleted by this Terraform module, but disabling/deleting it can make retained encrypted logs unreadable.

## Security and disaster-recovery limits before Stage 11

- The coordinator's Docker-socket authority requires a dedicated host. Do not co-locate unrelated workloads.
- Workers receive only the current checkout and fixed non-secret environment. They never receive the Docker socket, private key, coordinator environment, instance profile intentionally, or sibling workspace mounts. `.git` is over-mounted read-only.
- Docker's `DOCKER-USER` chain rejects worker traffic to `169.254.169.254`; IMDSv2 with hop limit 1 is defense in depth, not the only control. Verify the rule after Docker upgrades or networking changes.
- `npm ci` still needs bridge-network internet egress. A malicious dependency lifecycle script can exfiltrate repository contents or attack arbitrary reachable internet services. There is no domain allowlist, proxy, VPC egress firewall, or private npm mirror in this stage. Tests remain `--network none`.
- Docker isolation is a substantial boundary but not equivalent to a VM/microVM boundary for hostile native code. Keep Docker, kernel, AL2023, and both base images patched through immutable releases.
- This is a single instance, single-AZ process with brief update downtime. There is no autoscaling, hot standby, EBS snapshot schedule, external job store, queue recovery, retry, accepted-event persistence, or workspace backup.
- Graceful shutdown stops HTTP and waits at most 30 seconds for in-process work. Remaining jobs are terminated and not recovered. ALB deregistration delay does not make jobs durable.
- Broad outbound instance egress is required by the current design. Add explicit egress controls in a later hardening stage if your dependency and API endpoints can be enumerated.
- Secrets are refreshed only during deployment/update, not continuously. Rotation requires rerunning the SSM deployment command.
- CloudWatch delivery is best effort during outages: non-blocking buffering protects coordinator availability but can drop logs after 4 MB, and the local troubleshooting cache is not an instance-independent backup.
- The ALB has no WAF or application rate limiting. Webhook authentication remains the random shared header over HTTPS.
