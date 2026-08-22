import { spawn } from "node:child_process";
import type { AgentReport } from "./agent.js";

export interface ProcessOutput {
  stdout: string;
  stderr: string;
}

export type ProcessRunner = (program: string, args: string[], cwd: string) => Promise<ProcessOutput>;

export interface PullRequestOptions {
  root: string;
  task: string;
  branch: string;
  startingCommit: string;
  baseBranch: string;
  title?: string;
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
  return `Guillermo: ${compactTask(task, 72 - "Guillermo: ".length)}`;
}

export function derivePullRequestTitle(task: string): string {
  return `Guillermo: ${compactTask(task, 120 - "Guillermo: ".length)}`;
}

/**
 * Publishes only the branch that this run just created. All commands use argument
 * arrays, so task text, paths, and Git refs are never interpreted by a shell.
 */
export async function createPullRequest(
  report: AgentReport,
  options: PullRequestOptions,
  run: ProcessRunner = runProcess,
): Promise<PullRequestResult> {
  const eligibility = evaluatePullRequestEligibility(report);
  if (!eligibility.eligible) return { status: "skipped", reason: eligibility.reason };

  let commitSha: string | undefined;
  let pushedBranch: string | undefined;
  try {
    await run("git", ["remote", "get-url", "origin"], options.root);
    await run("git", ["check-ref-format", "--branch", options.baseBranch], options.root);
    await run("gh", ["auth", "status"], options.root);

    try {
      await run("git", ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${options.branch}`], options.root);
      return { status: "skipped", reason: `Remote branch "${options.branch}" already exists; Guillermo will not push an existing branch.` };
    } catch (error) {
      if (exitCode(error) !== 2) throw error;
    }

    const currentBranch = (await run("git", ["branch", "--show-current"], options.root)).stdout.trim();
    if (currentBranch !== options.branch) {
      return { status: "skipped", reason: "The working branch changed during the agent run; Guillermo will not publish it." };
    }
    const currentHead = (await run("git", ["rev-parse", "HEAD"], options.root)).stdout.trim();
    if (currentHead !== options.startingCommit) {
      return { status: "skipped", reason: "HEAD changed during the agent run; Guillermo will not add another commit." };
    }
    const changedPaths = parseChangedPaths((await run("git", ["status", "--porcelain=v1", "-z"], options.root)).stdout);
    if (changedPaths.length === 0) {
      return { status: "skipped", reason: "No uncommitted files remained to commit." };
    }

    await run("git", ["add", "--all", "--", ...changedPaths], options.root);
    await run("git", ["commit", "-m", deriveCommitMessage(options.task)], options.root);
    commitSha = (await run("git", ["rev-parse", "HEAD"], options.root)).stdout.trim();
    await run("git", ["push", "--set-upstream", "origin", options.branch], options.root);
    pushedBranch = options.branch;
    const title = options.title?.trim() || derivePullRequestTitle(options.task);
    const prOutput = await run("gh", [
      "pr", "create",
      "--base", options.baseBranch,
      "--head", options.branch,
      "--title", title,
      "--body", `Created by Guillermo for: ${compactTask(options.task, 500)}`,
    ], options.root);
    const pullRequestUrl = prOutput.stdout.trim();
    if (!pullRequestUrl) throw new Error("gh pr create completed without printing a pull request URL.");

    return { status: "created", commitSha, pushedBranch, pullRequestUrl };
  } catch (error) {
    return { status: "failed", reason: commandErrorMessage(error), commitSha, pushedBranch };
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

function exitCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "number"
    ? error.code
    : undefined;
}

function commandErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const stderr = typeof (error as Error & { stderr?: unknown }).stderr === "string"
      ? (error as Error & { stderr: string }).stderr.trim()
      : "";
    return stderr || error.message;
  }
  return String(error);
}

function runProcess(program: string, args: string[], cwd: string): Promise<ProcessOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${program} ${args[0] ?? ""} exited with ${code}`), { code, stdout, stderr }));
    });
  });
}
