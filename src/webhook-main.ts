import process from "node:process";
import { loadConfig } from "./config.js";
import { parseProjectMap } from "./jira.js";
import { runGuillermo } from "./run.js";
import { createWebhookServer, InProcessJobQueue } from "./webhook.js";

loadEnvironment();
const config = loadConfig();
const secret = requiredEnvironment("GUILLERMO_JIRA_WEBHOOK_SECRET");
const projects = parseProjectMap(requiredEnvironment("GUILLERMO_JIRA_PROJECTS"));
const port = parsePort(process.env.GUILLERMO_WEBHOOK_PORT ?? "3000");
const host = process.env.GUILLERMO_WEBHOOK_HOST ?? "127.0.0.1";

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
});
const server = createWebhookServer({ secret, projects, queue });
server.listen(port, host, () => {
  console.log(JSON.stringify({ event: "listening", host, port }));
});

function loadEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
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
