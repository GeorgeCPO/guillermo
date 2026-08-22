import path from "node:path";
import process from "node:process";
import { access, realpath } from "node:fs/promises";
import { runAgent, type AgentReport } from "./agent.js";
import { loadConfig } from "./config.js";
import { deriveDefaultBranchName } from "./branch.js";
import { createPullRequest, type PullRequestResult } from "./pull-request.js";
import { Repository } from "./repository.js";

interface CliOptions {
  repo: string;
  task: string;
  model?: string;
  maxSteps?: number;
  branch?: string;
  prTitle?: string;
  baseBranch?: string;
}

async function main(): Promise<void> {
  loadEnvironment();
  const options = parseCli(process.argv.slice(2));
  // Validate local configuration before changing the target repository.
  const config = loadConfig({ model: options.model, maxSteps: options.maxSteps });
  await access(options.repo);
  const root = await realpath(options.repo);
  const repository = new Repository(root);
  await repository.assertGitRepository();
  await repository.assertCleanWorkingTree();

  const originalBranch = await repository.currentBranch();
  const createdBranch = options.branch ?? deriveDefaultBranchName(options.task);
  await repository.createAndCheckoutBranch(createdBranch);
  const startingCommit = await repository.headCommit();

  let report: AgentReport;
  try {
    report = await runAgent(config, repository, options.task);
  } catch (error) {
    report = await failedAgentReport(repository, error);
  }
  const pullRequest = await createPullRequest(report, {
    root,
    task: options.task,
    branch: createdBranch,
    startingCommit,
    baseBranch: options.baseBranch ?? originalBranch,
    title: options.prTitle,
  });
  console.log(renderReport(report, originalBranch, createdBranch, pullRequest));
}

function loadEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error: unknown) {
    if (!(error instanceof Error) || !isMissingEnvFile(error)) throw error;
  }
}

function isMissingEnvFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

function parseCli(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) usage();
    values.set(flag.slice(2), value);
  }
  const repo = values.get("repo");
  const task = values.get("task");
  if (!repo || !task) usage();
  const maxStepsValue = values.get("max-steps");
  const maxSteps = maxStepsValue ? Number(maxStepsValue) : undefined;
  if (maxStepsValue && !Number.isSafeInteger(maxSteps)) usage();
  return {
    repo: path.resolve(repo),
    task,
    model: values.get("model"),
    maxSteps,
    branch: values.get("branch"),
    prTitle: values.get("pr-title"),
    baseBranch: values.get("base"),
  };
}

function usage(): never {
  throw new Error("Usage: npm run dev -- --repo /absolute/path/to/repo --task \"Describe the change\" [--branch name] [--base branch] [--pr-title title] [--model model] [--max-steps 12]");
}

async function failedAgentReport(repository: Repository, error: unknown): Promise<AgentReport> {
  const failure = error instanceof Error ? error.message : String(error);
  let changedFiles: string[] = [];
  let diff = "Could not read the working-tree diff after the agent failed.";
  try {
    [changedFiles, diff] = await Promise.all([repository.changedFiles(), repository.diff()]);
  } catch {
    // The original agent failure is the useful error to preserve in the final report.
  }
  return {
    summary: `Agent failed: ${failure}`,
    termination: "failed",
    changedFiles,
    diff,
    testRuns: [],
    events: ["Agent: failed before finish."],
  };
}

function renderReport(report: AgentReport, originalBranch: string, createdBranch: string, pullRequest: PullRequestResult): string {
  const tests = report.testRuns.length === 0
    ? "No tests were run."
    : report.testRuns.map(({ command, result }) => `$ ${command}\nexit ${result.exitCode}\n${result.output}`).join("\n\n");
  return [
    "\n=== Guillermo report ===",
    `Summary: ${report.summary}`,
    `Termination: ${report.termination}`,
    `\nBranches:\nOriginal: ${originalBranch}\nWorking: ${createdBranch}`,
    `\nTool events:\n${report.events.join("\n") || "No tools were called."}`,
    `\nChanged files:\n${report.changedFiles.join("\n") || "No changes."}`,
    `\nTests:\n${tests}`,
    `\nPull request:\n${renderPullRequest(pullRequest)}`,
    `\nDiff:\n${report.diff}`,
  ].join("\n");
}

function renderPullRequest(result: PullRequestResult): string {
  if (result.status === "created") {
    return `Status: created\nCommit SHA: ${result.commitSha}\nPushed branch: ${result.pushedBranch}\nPR URL: ${result.pullRequestUrl}`;
  }
  return [
    `Status: ${result.status}`,
    `Reason: ${result.reason ?? "No additional detail was available."}`,
    `Commit SHA: ${result.commitSha ?? "Not created"}`,
    `Pushed branch: ${result.pushedBranch ?? "Not pushed"}`,
    `PR URL: ${result.pullRequestUrl ?? "Not created"}`,
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
