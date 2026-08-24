import { execFile, spawn } from "node:child_process";
import { promisify, TextDecoder } from "node:util";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { resolveRepositoryPath, validatePatch, validateTestCommand } from "./safety.js";

const execFileAsync = promisify(execFile);
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "coverage", ".guillermo"]);
const MAX_FILE_BYTES = 100_000;

export interface CommandResult {
  exitCode: number;
  output: string;
}

export interface SearchResult {
  path: string;
  line: number;
  text: string;
}

export class Repository {
  public constructor(public readonly root: string) {}

  async assertGitRepository(): Promise<void> {
    await this.runGit(["rev-parse", "--is-inside-work-tree"]);
  }

  async assertCleanWorkingTree(): Promise<void> {
    const { stdout } = await this.runGit(["status", "--porcelain=v1", "--untracked-files=all"]);
    if (stdout.trim()) {
      throw new Error("Target repository has a dirty working tree. Commit, stash, or discard its changes before running Guillermo.");
    }
  }

  async currentBranch(): Promise<string> {
    try {
      const { stdout } = await this.runGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
      return stdout.trim();
    } catch (error) {
      const result = error as { code?: number };
      if (result.code !== 1) throw error;
      const { stdout } = await this.runGit(["rev-parse", "--short", "HEAD"]);
      return `detached HEAD at ${stdout.trim()}`;
    }
  }

  async headCommit(): Promise<string> {
    const { stdout } = await this.runGit(["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  async createAndCheckoutBranch(branchName: string, startPoint?: string): Promise<void> {
    await this.assertValidNewBranchName(branchName);
    if (await this.localBranchExists(branchName)) {
      throw new Error(`Branch "${branchName}" already exists. Guillermo will not reuse or overwrite it.`);
    }
    if (startPoint !== undefined) {
      await this.assertValidBranchName(startPoint, "Git base branch name");
      if (!await this.localBranchExists(startPoint)) {
        throw new Error(`Base branch "${startPoint}" does not exist locally. Guillermo will not guess or fetch a replacement.`);
      }
    }

    try {
      // An explicit start point prevents unattended webhook runs from inheriting
      // the previously created branch. Git still refuses a branch created concurrently.
      await this.runGit(["switch", "--create", branchName, ...(startPoint ? [startPoint] : [])]);
    } catch (error) {
      throw new Error(`Could not create and check out branch "${branchName}": ${gitErrorMessage(error)}`);
    }
  }

  async listFiles(relativePath = ".", maxEntries = 200): Promise<string[]> {
    const start = relativePath === "." ? this.root : resolveRepositoryPath(this.root, relativePath);
    const entries: string[] = [];
    const visit = async (directory: string): Promise<void> => {
      if (entries.length >= maxEntries) return;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entries.length >= maxEntries) return;
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

  async searchText(query: string, relativePath = ".", maxResults = 100): Promise<SearchResult[]> {
    if (query.length === 0) throw new Error("Search query must be non-empty.");
    if (!Number.isSafeInteger(maxResults) || maxResults < 1 || maxResults > 100) {
      throw new Error("max_results must be an integer between 1 and 100.");
    }

    const start = relativePath === "." ? this.root : resolveRepositoryPath(this.root, relativePath);
    // A repository-relative symlink can otherwise point the search outside the selected repository.
    const [realRoot, realStart] = await Promise.all([realpath(this.root), realpath(start)]);
    if (!isWithinDirectory(realRoot, realStart)) throw new Error("Search path resolved outside the repository root.");
    const startMetadata = await stat(start);
    if (!startMetadata.isDirectory()) throw new Error("Search path is not a directory.");
    const startSegments = path.relative(this.root, start).split(path.sep);
    if (startSegments.some((segment) => IGNORED_DIRECTORIES.has(segment))) {
      throw new Error("Search path is in an ignored directory.");
    }

    const results: SearchResult[] = [];
    const visit = async (directory: string): Promise<void> => {
      if (results.length >= maxResults) return;
      const directoryEntries = await readdir(directory, { withFileTypes: true });
      // Filesystems do not promise a stable directory-entry order.
      directoryEntries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

      for (const entry of directoryEntries) {
        if (results.length >= maxResults) return;
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;

        const filePath = path.relative(this.root, fullPath).split(path.sep).join("/");
        // Root searches must not expose files blocked by the same policy as direct reads.
        try {
          resolveRepositoryPath(this.root, filePath);
        } catch {
          continue;
        }
        const metadata = await stat(fullPath);
        if (metadata.size > MAX_FILE_BYTES) continue;
        const contents = await readFile(fullPath);
        if (contents.includes(0)) continue;

        let text: string;
        try {
          // Fatal decoding rejects non-text byte sequences instead of substituting replacement characters.
          text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        } catch {
          continue;
        }
        for (const [index, line] of text.split(/\r?\n/).entries()) {
          if (line.includes(query)) results.push({ path: filePath, line: index + 1, text: line });
          if (results.length >= maxResults) return;
        }
      }
    };

    await visit(start);
    return results;
  }

  async applyPatch(patch: string): Promise<CommandResult> {
    validatePatch(patch, this.root);
    await this.runGit(["apply", "--check", "--whitespace=error-all", "-"], patch);
    const { stdout, stderr } = await this.runGit(["apply", "--whitespace=error-all", "-"], patch);
    return { exitCode: 0, output: compactOutput(`${stdout}${stderr}`) };
  }

  async runTests(command: string): Promise<CommandResult> {
    const safeCommand = validateTestCommand(command);
    const [program, ...args] = safeCommand.split(/\s+/);
    try {
      const { stdout, stderr } = await execFileAsync(program, args, { cwd: this.root, maxBuffer: 500_000 });
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

  private async assertValidNewBranchName(branchName: string): Promise<void> {
    if (!branchName || branchName.startsWith("-")) {
      throw new Error("Branch name must be a non-empty Git branch name.");
    }
    await this.assertValidBranchName(branchName, "Git branch name");
  }

  private async assertValidBranchName(branchName: string, label: string): Promise<void> {
    if (!branchName || branchName.startsWith("-")) {
      throw new Error(`${label} must be a non-empty Git branch name.`);
    }
    try {
      await this.runGit(["check-ref-format", "--branch", branchName]);
    } catch {
      throw new Error(`Invalid ${label}: "${branchName}".`);
    }
  }

  private async localBranchExists(branchName: string): Promise<boolean> {
    try {
      await this.runGit(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
      return true;
    } catch (error) {
      const result = error as { code?: number };
      if (result.code === 1) return false;
      throw error;
    }
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

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const result = error as Error & { stderr?: string };
    return result.stderr?.trim() || error.message;
  }
  return String(error);
}

function compactOutput(output: string): string {
  const limit = 12_000;
  return output.length <= limit ? output : `${output.slice(0, limit)}\n… output truncated by Guillermo`;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}
