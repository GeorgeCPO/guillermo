import process from "node:process";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../config/config.js";
import { loadEnvironmentFile } from "../../config/environment.js";
import { loadWebhookRuntimeConfig } from "../../config/webhook-config.js";
import { loadSandboxConfig } from "../../config/sandbox-config.js";
import { parseProjectMap } from "../../integrations/jira/jira.js";
import { InProcessJobQueue } from "../../application/job-queue.js";
import { summarizeJobExecution } from "../../application/job-observability.js";
import { runRemoteJob } from "../../application/remote-job.js";
import { ManagedWorkspaceProvider } from "../../application/managed-workspace.js";
import { GitHubAppTokenProvider, GitHubRestApi } from "../../integrations/github/github-app.js";
import { DockerSandboxProvider } from "../../infrastructure/docker/docker-sandbox.js";
import { createWebhookApp } from "./server.js";
import { installShutdownHandlers } from "./shutdown.js";

const DEFAULT_HTTP_PORT = 3000;
const DEFAULT_HTTP_HOST = "127.0.0.1";
const MIN_PORT = 1;
const MAX_PORT = 65_535;

loadEnvironmentFile();
const config = loadConfig();
const secret = requiredEnvironment("GUILLERMO_JIRA_WEBHOOK_SECRET");
const projects = parseProjectMap(requiredEnvironment("GUILLERMO_JIRA_PROJECTS"));
const webhookConfig = loadWebhookRuntimeConfig();
const sandboxConfig = loadSandboxConfig();
const tokenProvider = new GitHubAppTokenProvider(webhookConfig.githubApp);
const github = new GitHubRestApi(tokenProvider);
const workspaces = new ManagedWorkspaceProvider(tokenProvider, { temporaryRoot: webhookConfig.workspaceRoot });
const sandboxes = new DockerSandboxProvider(sandboxConfig);
const port = parsePort(process.env.GUILLERMO_WEBHOOK_PORT ?? String(DEFAULT_HTTP_PORT));
const host = process.env.GUILLERMO_WEBHOOK_HOST ?? DEFAULT_HTTP_HOST;

await sandboxes.assertReady();

let app: FastifyInstance;
const queue = new InProcessJobQueue(async (job) => {
  const result = await runRemoteJob(config, job, webhookConfig.commitAuthor, github, workspaces, sandboxes);
  return summarizeJobExecution(result);
}, (record) => app.log.info(record));

app = createWebhookApp({ secret, projects, queue });
installShutdownHandlers(app, () => queue.waitForIdle());
try {
  await app.listen({ port, host });
  app.log.info({ event: "listening", host, port });
} catch (error) {
  app.log.error({ err: error }, "Failed to start webhook server");
  process.exitCode = 1;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    throw new Error("GUILLERMO_WEBHOOK_PORT must be an integer from 1 to 65535.");
  }
  return port;
}
