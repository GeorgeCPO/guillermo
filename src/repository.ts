import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseTestCommand, resolveRepositoryPath, validatePatch } from "./safety.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".guillermo"]);
const MAX_FILE_BYTES = 100_000;
const TEST_TIMEOUT_MS = 120_000;

export interface CommandResult {
  exitCode: number;
  output: string;
}

export class Repository {
  public constructor(public readonly root: string) {}

  async assertGitRepository(): Promise<void> {
    await this.runGit(["rev-parse", "--is-inside-work-tree"]);
  }

  async listFiles(relativePath = ".", maxEntries = 200): Promise<string[]> {
    const start = relativePath === "." ? this.root : resolveRepositoryPath(this.root, relativePath);
    const entries: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      if (entries.length >= maxEntries) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entries.length >= maxEntries) return;
        // Generated and dependency trees add noise and can be disproportionately
        // large; they are never useful context for this local agent.
        if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
        const fullPath = path.join(directory, entry.name);
        const relative = path.relative(this.root, fullPath).split(path.sep).join("/");
        if (entry.isDirectory()) await visit(fullPath);
        else if (entry.isFile()) entries.push(relative);
      }
    };
    await visit(start);
    return entries;
  }

  async readTextFile(relativePath: string, startLine = 1, endLine = 400): Promise<string> {
    const filePath = resolveRepositoryPath(this.root, relativePath);
    const metadata = await stat(filePath);
    if (!metadata.isFile()) throw new Error("Path is not a file.");
    if (metadata.size > MAX_FILE_BYTES) throw new Error(`File is too large to read (${metadata.size} bytes).`);
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine || endLine - startLine > 400) {
      throw new Error("Line range must be valid and contain at most 400 lines.");
    }
    const lines = (await readFile(filePath, "utf8")).split("\n");
    return lines.slice(startLine - 1, endLine).map((line, index) => `${startLine + index}: ${line}`).join("\n");
  }

  async applyPatch(patch: string): Promise<CommandResult> {
    await this.checkPatch(patch);
    const { stdout, stderr } = await this.runGit(["apply", "--whitespace=error-all", "-"], patch);
    return { exitCode: 0, output: compactOutput(`${stdout}${stderr}`) };
  }

  async checkPatch(patch: string): Promise<void> {
    // Validate both our conservative policy and Git's view of patch context
    // before applying a change inside the disposable worktree.
    validatePatch(patch, this.root);
    await this.runGit(["apply", "--check", "--whitespace=error-all", "-"], patch);
  }

  async runTests(command: string): Promise<CommandResult> {
    // execFile receives an argument vector, never a shell command string.
    const [program, ...args] = parseTestCommand(command);
    try {
      const { stdout, stderr } = await execFileAsync(program, args, {
        cwd: this.root,
        maxBuffer: 500_000,
        timeout: TEST_TIMEOUT_MS,
      });
      return { exitCode: 0, output: compactOutput(`${stdout}${stderr}`) };
    } catch (error) {
      const result = error as { code?: number; stdout?: string; stderr?: string; message: string };
      return {
        exitCode: typeof result.code === "number" ? result.code : 1,
        output: compactOutput(`${result.stdout ?? ""}${result.stderr ?? ""}\n${result.message}`),
      };
    }
  }

  async diff(): Promise<string> {
    const { stdout } = await this.runGit(["diff", "--no-ext-diff", "--binary"]);
    return stdout || "No uncommitted changes.";
  }

  async changedFiles(): Promise<string[]> {
    const { stdout } = await this.runGit(["status", "--short"]);
    return stdout.split("\n").filter(Boolean);
  }

  private async runGit(args: string[], input?: string): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn("git", args, { cwd: this.root, stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) resolve({ stdout, stderr });
        else reject(Object.assign(new Error(`git ${args[0]} exited with ${code}`), { code, stdout, stderr }));
      });
      child.stdin.end(input);
    });
  }
}

function compactOutput(output: string): string {
  const limit = 12_000;
  return output.length <= limit ? output : `${output.slice(0, limit)}\n… output truncated by Guillermo`;
}
