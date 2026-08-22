import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/** A detached worktree that is always outside the repository supplied by the user. */
export class DisposableWorktree {
  private constructor(
    public readonly sourceRoot: string,
    public readonly root: string,
    private readonly temporaryRoot: string,
  ) {}

  static async create(sourceRoot: string): Promise<DisposableWorktree> {
    // A clean source checkout makes the reported diff unambiguous and prevents
    // an agent run from accidentally being mistaken for the user's own work.
    await runGit(sourceRoot, ["diff", "--quiet"]);
    await runGit(sourceRoot, ["diff", "--cached", "--quiet"]);

    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "guillermo-worktree-"));
    const root = path.join(temporaryRoot, "repository");
    try {
      await runGit(sourceRoot, ["worktree", "add", "--detach", root, "HEAD"]);
      return new DisposableWorktree(sourceRoot, root, temporaryRoot);
    } catch (error) {
      await rm(temporaryRoot, { recursive: true, force: true });
      throw error;
    }
  }

  async dispose(): Promise<void> {
    try {
      // Tell Git first so it removes its worktree metadata, then remove the
      // temporary parent as a fallback if worktree creation only partly worked.
      await runGit(this.sourceRoot, ["worktree", "remove", "--force", this.root]);
    } finally {
      await rm(this.temporaryRoot, { recursive: true, force: true });
    }
  }
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { output += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed${output ? `: ${output.trim()}` : ""}`));
    });
  });
}
