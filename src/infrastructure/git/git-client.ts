import {
  assertProcessSuccess,
  defaultProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from "../process/process-runner.js";

export interface GitClient {
  assertRepository(cwd: string): Promise<void>;
  workingTreeStatus(cwd: string): Promise<string>;
  symbolicBranch(cwd: string): Promise<string | null>;
  shortHead(cwd: string): Promise<string>;
  head(cwd: string): Promise<string>;
  isValidBranchName(cwd: string, branch: string): Promise<boolean>;
  localBranchExists(cwd: string, branch: string): Promise<boolean>;
  createAndSwitchBranch(cwd: string, branch: string, startPoint?: string): Promise<void>;
  checkPatch(cwd: string, patch: string): Promise<void>;
  applyPatch(cwd: string, patch: string): Promise<ProcessResult>;
  diff(cwd: string): Promise<string>;
  changedFiles(cwd: string): Promise<string[]>;
  originUrl(cwd: string): Promise<string>;
  remoteBranchExists(cwd: string, branch: string): Promise<boolean>;
  currentBranch(cwd: string): Promise<string>;
  porcelainStatus(cwd: string): Promise<string>;
  addPaths(cwd: string, paths: readonly string[]): Promise<void>;
  commit(cwd: string, message: string): Promise<void>;
  pushBranch(cwd: string, branch: string): Promise<void>;
}

export class ProcessGitClient implements GitClient {
  public constructor(private readonly runner: ProcessRunner = defaultProcessRunner) {}

  async assertRepository(cwd: string): Promise<void> {
    await this.run(cwd, ["rev-parse", "--is-inside-work-tree"]);
  }

  async workingTreeStatus(cwd: string): Promise<string> {
    return (await this.run(cwd, ["status", "--porcelain=v1", "--untracked-files=all"])).stdout;
  }

  async symbolicBranch(cwd: string): Promise<string | null> {
    const result = await this.execute(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (result.exitCode === 1) return null;
    return assertProcessSuccess(result, "git symbolic-ref").stdout.trim();
  }

  async shortHead(cwd: string): Promise<string> {
    return (await this.run(cwd, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  }

  async head(cwd: string): Promise<string> {
    return (await this.run(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async isValidBranchName(cwd: string, branch: string): Promise<boolean> {
    const result = await this.execute(cwd, ["check-ref-format", "--branch", branch]);
    if (result.exitCode !== null && result.exitCode !== 0) return false;
    assertProcessSuccess(result, "git check-ref-format");
    return true;
  }

  async localBranchExists(cwd: string, branch: string): Promise<boolean> {
    const result = await this.execute(cwd, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    if (result.exitCode === 1) return false;
    assertProcessSuccess(result, "git show-ref");
    return true;
  }

  async createAndSwitchBranch(cwd: string, branch: string, startPoint?: string): Promise<void> {
    await this.run(cwd, ["switch", "--create", branch, ...(startPoint ? [startPoint] : [])]);
  }

  async checkPatch(cwd: string, patch: string): Promise<void> {
    await this.run(cwd, ["apply", "--check", "--whitespace=error-all", "-"], patch);
  }

  async applyPatch(cwd: string, patch: string): Promise<ProcessResult> {
    return this.run(cwd, ["apply", "--whitespace=error-all", "-"], patch);
  }

  async diff(cwd: string): Promise<string> {
    return (await this.run(cwd, ["diff", "--no-ext-diff", "--binary"])).stdout;
  }

  async changedFiles(cwd: string): Promise<string[]> {
    return (await this.run(cwd, ["status", "--short"])).stdout.split("\n").filter(Boolean);
  }

  async originUrl(cwd: string): Promise<string> {
    return (await this.run(cwd, ["remote", "get-url", "origin"])).stdout.trim();
  }

  async remoteBranchExists(cwd: string, branch: string): Promise<boolean> {
    const result = await this.execute(cwd, ["ls-remote", "--exit-code", "--heads", "origin", `refs/heads/${branch}`]);
    if (result.exitCode === 2) return false;
    assertProcessSuccess(result, "git ls-remote");
    return true;
  }

  async currentBranch(cwd: string): Promise<string> {
    return (await this.run(cwd, ["branch", "--show-current"])).stdout.trim();
  }

  async porcelainStatus(cwd: string): Promise<string> {
    return (await this.run(cwd, ["status", "--porcelain=v1", "-z"])).stdout;
  }

  async addPaths(cwd: string, paths: readonly string[]): Promise<void> {
    await this.run(cwd, ["add", "--all", "--", ...paths]);
  }

  async commit(cwd: string, message: string): Promise<void> {
    await this.run(cwd, ["commit", "-m", message]);
  }

  async pushBranch(cwd: string, branch: string): Promise<void> {
    await this.run(cwd, ["push", "--set-upstream", "origin", branch]);
  }

  private execute(cwd: string, args: readonly string[], input?: string): Promise<ProcessResult> {
    return this.runner.run({ executable: "git", args, cwd, ...(input === undefined ? {} : { input }) });
  }

  private async run(cwd: string, args: readonly string[], input?: string): Promise<ProcessResult> {
    return assertProcessSuccess(await this.execute(cwd, args, input), `git ${args[0] ?? "command"}`);
  }
}
