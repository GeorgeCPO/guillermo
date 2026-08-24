import process from "node:process";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "../../config/config.js";
import { loadEnvironmentFile } from "../../config/environment.js";
import { parseProjectMap } from "../../integrations/jira/jira.js";
import { InProcessJobQueue } from "../../application/job-queue.js";
import { runGuillermo } from "../../application/run.js";
import { createWebhookApp } from "./server.js";

loadEnvironmentFile();
const config = loadConfig();
const secret = requiredEnvironment("GUILLERMO_JIRA_WEBHOOK_SECRET");
const projects = parseProjectMap(requiredEnvironment("GUILLERMO_JIRA_PROJECTS"));
const port = parsePort(process.env.GUILLERMO_WEBHOOK_PORT ?? "3000");
const host = process.env.GUILLERMO_WEBHOOK_HOST ?? "127.0.0.1";

let app: FastifyInstance;
const queue = new InProcessJobQueue(async (job) => {
  const result = await runGuillermo(config, {
    repo: job.repositoryPath,
    task: job.task,
    branch: job.branch,
    branchStartPoint: job.baseBranch,
    baseBranch: job.baseBranch,
    prTitle: job.prTitle,
  });
  return { outcome: result.pullRequest.status };
}, (record) => app.log.info(record));

app = createWebhookApp({ secret, projects, queue });
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
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("GUILLERMO_WEBHOOK_PORT must be an integer from 1 to 65535.");
  return port;
}
