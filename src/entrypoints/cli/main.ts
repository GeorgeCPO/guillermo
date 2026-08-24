import process from "node:process";
import type { AgentReport } from "../../agent/agent.js";
import { parseCli } from "./cli.js";
import { loadConfig } from "../../config/config.js";
import { loadEnvironmentFile } from "../../config/environment.js";
import type { PullRequestResult } from "../../integrations/github/pull-request.js";
import { runGuillermo } from "../../application/run.js";

export async function runCli(args: readonly string[], cwd: string): Promise<void> {
  const parsed = parseCli(args, cwd);
  if (parsed.kind === "help") {
    console.log(parsed.text);
    return;
  }

  loadEnvironmentFile();
  const options = parsed.options;
  // Validate local configuration before changing the target repository.
  const config = loadConfig({ model: options.model, maxSteps: options.maxSteps });
  const { report, originalBranch, createdBranch, pullRequest } = await runGuillermo(config, {
    repo: options.repo,
    task: options.task,
    branch: options.branch,
    baseBranch: options.baseBranch,
    prTitle: options.prTitle,
  });
  console.log(renderReport(report, originalBranch, createdBranch, pullRequest));
}

runCli(process.argv.slice(2), process.cwd()).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

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
