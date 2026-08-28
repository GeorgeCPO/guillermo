import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const asset = (relative: string) => path.join(root, relative);

test("coordinator image is pinned, multi-stage, production-only, and non-root", async () => {
  const dockerfile = await readFile(asset("Dockerfile.coordinator"), "utf8");
  assert.match(dockerfile, /^FROM docker:[^\n]+@sha256:[a-f0-9]{64} AS docker-cli/m);
  assert.equal((dockerfile.match(/^FROM node:[^\n]+@sha256:[a-f0-9]{64}/gm) ?? []).length, 3);
  assert.match(dockerfile, /RUN npm run build/);
  assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
  assert.match(dockerfile, /apt-get install[^\n]*ca-certificates git/);
  assert.match(dockerfile, /COPY --from=docker-cli \/usr\/local\/bin\/docker/);
  assert.match(dockerfile, /ENV NODE_ENV=production/);
  assert.match(dockerfile, /USER 10001:10001/);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision/);
  assert.doesNotMatch(dockerfile, /COPY .*\.env|COPY .*tests|Dockerfile\.worker/);

  const ignore = await readFile(asset("Dockerfile.coordinator.dockerignore"), "utf8");
  assert.match(ignore, /^\*\*$/m);
  assert.doesNotMatch(ignore, /!tests|!\.env|!node_modules/);
});

test("EC2 Compose runs only the coordinator with host-resolvable workspace and hardening", async () => {
  const compose = await readFile(asset("deploy/aws/compose.yaml"), "utf8");
  assert.equal((compose.match(/^  [a-z][a-z-]+:\s*$/gm) ?? []).length, 1);
  for (const expected of [
    "GUILLERMO_COORDINATOR_IMAGE", "GUILLERMO_WORKER_IMAGE", "GUILLERMO_DOCKER_GID",
    "user: \"10001:10001\"", "source: /var/lib/guillermo/workspaces",
    "target: /var/lib/guillermo/workspaces", "source: /etc/guillermo/github-app.pem",
    "read_only: true", "cap_drop:", "- ALL", "no-new-privileges:true", "init: true",
    "restart: unless-stopped", "max-size: 10m", "/healthz", "DOCKER_HOST",
  ]) assert.match(compose, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(compose, /source: \$\{GUILLERMO_DOCKER_SOCKET_PATH:-\/var\/run\/docker\.sock\}/);
  assert.doesNotMatch(compose, /image:\s*[^\n]*latest/);
});

test("Terraform captures the required single-instance security architecture", async () => {
  const files = await Promise.all(["main.tf", "variables.tf", "outputs.tf"].map((name) =>
    readFile(asset(`deploy/aws/terraform/${name}`), "utf8")));
  const terraform = files.join("\n");
  for (const expected of [
    "aws_ecr_repository", "IMMUTABLE", "scan_on_push = true", "aws_instance", "http_tokens",
    "required", "encrypted   = true", "aws_lb_listener", "HTTPS", "acm_certificate_arn",
    "aws_lb_target_group", "/healthz", "aws_lb_target_group_attachment", "aws_iam_instance_profile",
    "AmazonSSMManagedInstanceCore", "secretsmanager:GetSecretValue", "ecr:BatchGetImage",
    "aws_vpc_security_group_ingress_rule", "referenced_security_group_id", "3000",
  ]) assert.match(terraform, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(terraform, /from_port\s*=\s*22|secret_value|private_key\s*=/);
  assert.match(terraform, /var\.release_tag != "latest"/);
});

test("bootstrap blocks container IMDS, provisions restrictive paths, and uses systemd", async () => {
  const bootstrap = await readFile(asset("deploy/aws/terraform/bootstrap.sh.tftpl"), "utf8");
  assert.match(bootstrap, /Amazon Linux 2023|dnf install -y docker/);
  assert.doesNotMatch(bootstrap, /dnf install[^\n]*\bcurl\b/);
  assert.match(bootstrap, /command -v curl >\/dev\/null/);
  assert.match(bootstrap, /DOCKER-USER -d 169\.254\.169\.254\/32 -j REJECT/);
  assert.match(bootstrap, /guillermo-imds-block\.service/);
  assert.match(bootstrap, /\/var\/lib\/guillermo\/workspaces/);
  assert.match(bootstrap, /-o guillermo -g guillermo -m 0750/);
  assert.match(bootstrap, /systemctl enable guillermo\.service/);
  assert.match(bootstrap, /amazon-ssm-agent/);
  assert.doesNotMatch(bootstrap, /set -x|echo .*SECRET|cat .*runtime\.json/);
});

test("webhook entrypoint wires the validated deployment workspace root into managed workspaces", async () => {
  const main = await readFile(asset("src/entrypoints/http/main.ts"), "utf8");
  assert.match(main, /new ManagedWorkspaceProvider\(tokenProvider, \{ temporaryRoot: webhookConfig\.workspaceRoot \}\)/);
  assert.doesNotMatch(main, /new ManagedWorkspaceProvider\(tokenProvider\);/);
});

test("release and deployment scripts reject latest and do not put secrets in arguments", async () => {
  for (const script of ["build-and-push.sh", "deploy-via-ssm.sh", "host-deploy-release.sh", "render-runtime-env.sh"]) {
    const location = asset(`deploy/aws/${script}`);
    const mode = (await stat(location)).mode & 0o777;
    assert.notEqual(mode & 0o100, 0, `${script} must be executable`);
    await execFileAsync("bash", ["-n", location]);
    const source = await readFile(location, "utf8");
    assert.match(source, /set \+x/);
  }
  const build = await readFile(asset("deploy/aws/build-and-push.sh"), "utf8");
  assert.match(build, /git rev-parse HEAD/);
  assert.match(build, /docker buildx build/);
  assert.match(build, /--push/);
  assert.match(build, /\[\[ \$release_tag == latest \]\]/);
  const host = await readFile(asset("deploy/aws/host-deploy-release.sh"), "utf8");
  assert.match(host, /get-login-password[^\n]*\| docker login[^\n]*--password-stdin/);
  assert.match(host, /get-secret-value[\s\S]*>"\$runtime_response"/);
  assert.doesNotMatch(host, /--secret-string|echo .*OPENAI|echo .*PRIVATE/);
  const renderer = await readFile(asset("deploy/aws/render-runtime-env.sh"), "utf8");
  assert.match(renderer, /GUILLERMO_MAX_STEPS/);
  assert.match(renderer, /\[1-4\]\[0-9\]\|50/);
});

test("secret rendering local simulation emits no secret output", async () => {
  const result = await execFileAsync("bash", [asset("deploy/aws/test-secret-rendering.sh")]);
  assert.match(result.stdout, /passed without stdout exposure/);
  assert.doesNotMatch(result.stdout + result.stderr, /test-openai-do-not-log|test-webhook-do-not-log/);
});
