import { access, realpath } from "node:fs/promises";
import { runAgent, type AgentReport } from "../agent/agent.js";
import type { GuillermoConfig } from "../config/config.js";
import { deriveDefaultBranchName } from "./branch.js";
import { createPullRequest, type PullRequestResult } from "../integrations/github/pull-request.js";
import { Repository } from "../repository/repository.js";

export interface RunOptions {
  repo: string;
  task: string;
  branch?: string;
  branchStartPoint?: string;
  prTitle?: string;
  baseBranch?: string;
}

export interface GuillermoRunResult {
  report: AgentReport;
  originalBranch: string;
  createdBranch: string;
  pullRequest: PullRequestResult;
}

export async function runGuillermo(config: GuillermoConfig, options: RunOptions): Promise<GuillermoRunResult> {
  await access(options.repo);
  const root = await realpath(options.repo);
  const repository = new Repository(root);
  await repository.assertGitRepository();
  await repository.assertCleanWorkingTree();

  const originalBranch = await repository.currentBranch();
  const createdBranch = options.branch ?? deriveDefaultBranchName(options.task);
  await repository.createAndCheckoutBranch(createdBranch, options.branchStartPoint);
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
  return { report, originalBranch, createdBranch, pullRequest };
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
