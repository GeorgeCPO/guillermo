# Guillermo Stage 10.5: single-EC2 deployment runbook

This runbook deploys one dedicated Amazon Linux 2023 EC2 host, one persistent trusted coordinator container, and ephemeral worker containers. Terraform creates the EC2, IAM, ECR, ALB, security-group, target-group, and optional Route 53 resources. It does not create or read secret values.

## 1. Prerequisites and costs

You need:

- an AWS account and AWS CLI credentials allowed to manage EC2, IAM, ECR, ELBv2, Systems Manager, and optionally Route 53;
- Terraform 1.6 or newer, Docker with Buildx, AWS CLI v2, `jq`, and Git;
- an existing VPC, two public subnets in different Availability Zones for the ALB, and an EC2 subnet with outbound internet access (normally a private subnet through NAT);
- a domain name and an ACM certificate in the deployment region covering the chosen hostname;
- a GitHub App installed only on the repositories Guillermo may change; and
- Jira Automation, because the Jira webhook request must include a custom secret header.

Costs normally include the continuously running EC2 instance, gp3 EBS volume, Application Load Balancer and LCUs, NAT gateway and data processing if used, public IPv4 if your VPC design uses one, Secrets Manager secrets/API calls, ECR storage/scanning, data transfer, and optional Route 53 hosted-zone/query charges. Review current AWS pricing for the selected region before applying.

The EC2 instance is a dedicated Guillermo host. Docker-socket access lets the coordinator control the host Docker daemon and is effectively host-root authority despite the coordinator's non-root Linux UID.

## 2. Certificate, DNS, and network prerequisites

Request or import an ACM certificate in the same region as the ALB. Validate it before applying. The certificate must cover, for example, `guillermo.example.com`.

Always supply `dns_name`. If Route 53 hosts the domain, also supply `route53_hosted_zone_id` and Terraform creates an A alias. Otherwise leave only the zone ID empty and create a CNAME/alias with your DNS provider from the ALB DNS-name output visible in the AWS console. The browser/client hostname must match the ACM certificate.

The ALB subnets must be public and route to an internet gateway. The EC2 subnet does not need inbound internet access, a public IP, SSH, or a key pair, but it must reach AWS APIs, ECR, GitHub, OpenAI, package repositories, and npm. A NAT gateway is the simplest private-subnet design. VPC endpoints can reduce some NAT paths but do not replace internet access required by GitHub, OpenAI, and npm.

Choose `allowed_https_cidrs`. `0.0.0.0/0` is compatible with changing Jira Cloud egress addresses but exposes the authenticated endpoint to the internet. Narrow it only if your Jira delivery source has stable documented ranges. Port 3000 is allowed solely from the ALB security group; port 22 is never opened.

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
- optional ECR repository names, root volume size, and tags.

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

## 7. Verify health and configure Jira

Wait for the target to become healthy, then request only the minimal endpoint:

```bash
curl --fail --silent --show-error "$HTTPS_ENDPOINT/healthz"
aws elbv2 describe-target-health \
  --region "$AWS_REGION" \
  --target-group-arn "$(cd deploy/aws/terraform && terraform output -raw target_group_arn)"
```

The body must be exactly `{"status":"ok"}` (JSON whitespace aside). It intentionally contains no project, job, repository, Docker, workspace, or configuration details.

In Jira Automation, create a rule for comment creation and a **Send web request** action:

- URL: `<HTTPS_ENDPOINT>/webhooks/jira`
- method: `POST`
- header: `Content-Type: application/json`
- header: `X-Guillermo-Webhook-Secret: <the configured webhook secret>`
- body: the Jira webhook JSON containing `webhookEvent`, issue fields, and comment.

Do not put the secret in the URL. A comment whose entire text is `/guillermo` should receive HTTP 202 and enqueue the in-memory job.

## 8. Administration and logs

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
sudo iptables -w -C DOCKER-USER -d 169.254.169.254/32 -j REJECT
```

Application request logging is disabled and structured job logs exclude bodies and credentials. Continue treating all operational logs as sensitive metadata.

Restart without changing the release:

```bash
sudo systemctl restart guillermo
```

## 9. Update and roll back

For an update, commit the desired source, choose that commit SHA as a new release tag, build/push both images, and run `deploy-via-ssm.sh` with the same tag. Coordinator and worker are always deployed as one release pair.

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
- The ALB has no WAF or application rate limiting. Webhook authentication remains the random shared header over HTTPS.
