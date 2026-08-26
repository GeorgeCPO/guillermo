import type { AgentReport } from "../../agent/agent.js";
import { repositoryHttpsUrl, type RepositoryTarget } from "../../application/repository-target.js";
import type { GitCommitAuthor } from "../../config/webhook-config.js";
import type { GitAuthentication } from "../../infrastructure/git/git-authentication.js";
import type { PullRequestApi } from "./github-app.js";
import { repositoryCommandEnvironment } from "../../infrastructure/process/safe-environment.js";
import { ProcessGitClient, type GitClient } from "../../infrastructure/git/git-client.js";
import {
  assertProcessSuccess,
  defaultProcessRunner,
  type ProcessRunner,
} from "../../infrastructure/process/process-runner.js";

const GENERATED_TITLE_PREFIX = "Guillermo: ";
const GENERATED_PR_BODY_PREFIX = "Created by Guillermo for: ";
const MAX_COMMIT_SUBJECT_LENGTH = 72;
const MAX_PR_TITLE_LENGTH = 120;
const MAX_PR_BODY_TASK_LENGTH = 500;

export interface PullRequestOptions {
  root: string;
  task: string;
  branch: string;
  startingCommit: string;
  baseBranch: string;
  title?: string;
}

export interface RemotePullRequestOptions extends PullRequestOptions {
  repository: RepositoryTarget;
  commitAuthor: GitCommitAuthor;
}

export interface PullRequestResult {
  status: "created" | "skipped" | "failed";
  reason?: string;
  commitSha?: string;
  pushedBranch?: string;
  pullRequestUrl?: string;
}

export interface PullRequestEligibility {
  eligible: boolean;
  reason?: string;
}

export function evaluatePullRequestEligibility(report: AgentReport): PullRequestEligibility {
  if (report.termination !== "finished") {
    const reason = report.termination === "step_limit"
      ? "The agent reached its step limit without calling finish."
      : report.termination === "failed"
        ? "The agent failed before calling finish."
        : "The agent stopped without calling finish.";
    return { eligible: false, reason };
  }
  if (report.changedFiles.length === 0) {
    return { eligible: false, reason: "The agent finished without changing any files." };
  }
  if (!report.testRuns.some(({ result }) => result.exitCode === 0)) {
    return { eligible: false, reason: "No run_tests invocation completed successfully." };
  }
  return { eligible: true };
}

export function deriveCommitMessage(task: string): string {
  return `${GENERATED_TITLE_PREFIX}${compactTask(task, MAX_COMMIT_SUBJECT_LENGTH - GENERATED_TITLE_PREFIX.length)}`;
}

export function derivePullRequestTitle(task: string): string {
  return `${GENERATED_TITLE_PREFIX}${compactTask(task, MAX_PR_TITLE_LENGTH - GENERATED_TITLE_PREFIX.length)}`;
}

/**
 * Publishes only the branch that this run just created. All commands use argument
 * arrays, so task text, paths, and Git refs are never interpreted by a shell.
 */
export async function createPullRequest(
  report: AgentReport,
  options: PullRequestOptions,
  runner: ProcessRunner = defaultProcessRunner,
  git: GitClient = new ProcessGitClient(runner),
): Promise<PullRequestResult> {
  const eligibility = evaluatePullRequestEligibility(report);
  if (!eligibility.eligible) return { status: "skipped", reason: eligibility.reason };

  let commitSha: string | undefined;
  let pushedBranch: string | undefined;
  try {
    await git.originUrl(options.root);
    if (!await git.isValidBranchName(options.root, options.baseBranch)) {
      throw new Error(`Invalid Git base branch name: "${options.baseBranch}".`);
    }
    await runGitHub(runner, options.root, ["auth", "status"]);

    if (await git.remoteBranchExists(options.root, options.branch)) {
      return { status: "skipped", reason: `Remote branch "${options.branch}" already exists; Guillermo will not push an existing branch.` };
    }

    const currentBranch = await git.currentBranch(options.root);
    if (currentBranch !== options.branch) {
      return { status: "skipped", reason: "The working branch changed during the agent run; Guillermo will not publish it." };
    }
    const currentHead = await git.head(options.root);
    if (currentHead !== options.startingCommit) {
      return { status: "skipped", reason: "HEAD changed during the agent run; Guillermo will not add another commit." };
    }
    const changedPaths = parseChangedPaths(await git.porcelainStatus(options.root));
    if (changedPaths.length === 0) {
      return { status: "skipped", reason: "No uncommitted files remained to commit." };
    }

    await git.addPaths(options.root, changedPaths);
    await git.commit(options.root, deriveCommitMessage(options.task));
    commitSha = await git.head(options.root);
    await git.pushBranch(options.root, options.branch);
    pushedBranch = options.branch;
    const title = options.title?.trim() || derivePullRequestTitle(options.task);
    const prOutput = await runGitHub(runner, options.root, [
      "pr", "create",
      "--base", options.baseBranch,
      "--head", options.branch,
      "--title", title,
      "--body", `${GENERATED_PR_BODY_PREFIX}${compactTask(options.task, MAX_PR_BODY_TASK_LENGTH)}`,
    ]);
    const pullRequestUrl = prOutput.stdout.trim();
    if (!pullRequestUrl) throw new Error("gh pr create completed without printing a pull request URL.");

    return { status: "created", commitSha, pushedBranch, pullRequestUrl };
  } catch (error) {
    return { status: "failed", reason: commandErrorMessage(error), commitSha, pushedBranch };
  }
}

/** Publishes a managed checkout with GitHub App credentials and the GitHub REST API. */
export async function createRemotePullRequest(
  report: AgentReport,
  options: RemotePullRequestOptions,
  authentication: GitAuthentication,
  api: PullRequestApi,
  git: GitClient = new ProcessGitClient(),
): Promise<PullRequestResult> {
  const eligibility = evaluatePullRequestEligibility(report);
  if (!eligibility.eligible) return { status: "skipped", reason: eligibility.reason };

  let commitSha: string | undefined;
  let pushedBranch: string | undefined;
  try {
    const [origin, pushOrigin] = await Promise.all([git.originUrl(options.root), git.originPushUrl(options.root)]);
    if (origin !== repositoryHttpsUrl(options.repository) || pushOrigin !== repositoryHttpsUrl(options.repository)) {
      return { status: "skipped", reason: "The Git origin changed during the agent run; Guillermo will not publish it." };
    }
    if (!await git.isValidBranchName(options.root, options.baseBranch)) {
      throw new Error(`Invalid Git base branch name: "${options.baseBranch}".`);
    }
    if (await authentication.withEnvironment((environment) => git.remoteBranchExists(options.root, options.branch, environment))) {
      return { status: "skipped", reason: `Remote branch "${options.branch}" already exists; Guillermo will not push an existing branch.` };
    }
    const currentBranch = await git.currentBranch(options.root);
    if (currentBranch !== options.branch) {
      return { status: "skipped", reason: "The working branch changed during the agent run; Guillermo will not publish it." };
    }
    const currentHead = await git.head(options.root);
    if (currentHead !== options.startingCommit) {
      return { status: "skipped", reason: "HEAD changed during the agent run; Guillermo will not add another commit." };
    }
    const changedPaths = parseChangedPaths(await git.porcelainStatus(options.root));
    if (changedPaths.length === 0) return { status: "skipped", reason: "No uncommitted files remained to commit." };

    await git.addPaths(options.root, changedPaths, repositoryCommandEnvironment());
    await git.commit(options.root, deriveCommitMessage(options.task), options.commitAuthor);
    commitSha = await git.head(options.root);
    await authentication.withEnvironment((environment) => git.pushBranch(options.root, options.branch, environment));
    pushedBranch = options.branch;
    const title = options.title?.trim() || derivePullRequestTitle(options.task);
    const pullRequestUrl = await api.createPullRequest({
      repository: options.repository,
      title,
      body: `${GENERATED_PR_BODY_PREFIX}${compactTask(options.task, MAX_PR_BODY_TASK_LENGTH)}`,
      head: options.branch,
      base: options.baseBranch,
    });
    return { status: "created", commitSha, pushedBranch, pullRequestUrl };
  } catch (error) {
    return {
      status: "failed",
      reason: authentication.redact(commandErrorMessage(error)),
      commitSha,
      pushedBranch,
    };
  }
}

export function parseChangedPaths(status: string): string[] {
  const fields = status.split("\0");
  const paths = new Set<string>();
  for (let index = 0; index < fields.length - 1; index += 1) {
    const entry = fields[index];
    if (!entry) continue;
    if (entry.length < 4 || entry[2] !== " ") throw new Error("Unexpected git status output.");
    paths.add(entry.slice(3));
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const originalPath = fields[++index];
      if (!originalPath) throw new Error("Unexpected renamed-file status output.");
      paths.add(originalPath);
    }
  }
  return [...paths];
}

function compactTask(task: string, maxLength: number): string {
  const compact = task.replace(/\s+/g, " ").trim();
  const value = compact || "task";
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

async function runGitHub(runner: ProcessRunner, cwd: string, args: readonly string[]) {
  return assertProcessSuccess(
    await runner.run({ executable: "gh", args, cwd }),
    `gh ${args[0] ?? "command"}`,
  );
}
