import { TextDecoder } from "node:util";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { ProcessGitClient, type GitClient } from "../infrastructure/git/git-client.js";
import {
  defaultProcessRunner,
  type ProcessRunner,
} from "../infrastructure/process/process-runner.js";
import { resolveRepositoryPath, validatePatch, validateTestCommand } from "./safety.js";

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
  public constructor(
    public readonly root: string,
    private readonly runner: ProcessRunner = defaultProcessRunner,
    private readonly git: GitClient = new ProcessGitClient(runner),
  ) {}

  async assertGitRepository(): Promise<void> {
    await this.git.assertRepository(this.root);
  }

  async assertCleanWorkingTree(): Promise<void> {
    if ((await this.git.workingTreeStatus(this.root)).trim()) {
      throw new Error("Target repository has a dirty working tree. Commit, stash, or discard its changes before running Guillermo.");
    }
  }

  async currentBranch(): Promise<string> {
    const branch = await this.git.symbolicBranch(this.root);
    return branch ?? `detached HEAD at ${await this.git.shortHead(this.root)}`;
  }

  async headCommit(): Promise<string> {
    return this.git.head(this.root);
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
      await this.git.createAndSwitchBranch(this.root, branchName, startPoint);
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
    // Lexical validation alone cannot stop a repository-relative symlink from
    // resolving to a file outside the selected repository.
    const [realRoot, realFilePath] = await Promise.all([realpath(this.root), realpath(filePath)]);
    if (!isWithinDirectory(realRoot, realFilePath)) throw new Error("File path resolved outside the repository root.");
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
    await this.git.checkPatch(this.root, patch);
    const { stdout, stderr } = await this.git.applyPatch(this.root, patch);
    return { exitCode: 0, output: compactOutput(`${stdout}${stderr}`) };
  }

  async runTests(command: string): Promise<CommandResult> {
    const safeCommand = validateTestCommand(command);
    const [program, ...args] = safeCommand.split(/\s+/);
    const result = await this.runner.run({ executable: program, args, cwd: this.root });
    const errorMessage = result.error?.message ? `\n${result.error.message}` : "";
    return {
      exitCode: result.exitCode ?? 1,
      output: compactOutput(`${result.stdout}${result.stderr}${errorMessage}`),
    };
  }

  async diff(): Promise<string> {
    return await this.git.diff(this.root) || "No uncommitted changes.";
  }

  async changedFiles(): Promise<string[]> {
    return this.git.changedFiles(this.root);
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
    if (!await this.git.isValidBranchName(this.root, branchName)) {
      throw new Error(`Invalid ${label}: "${branchName}".`);
    }
  }

  private async localBranchExists(branchName: string): Promise<boolean> {
    return this.git.localBranchExists(this.root, branchName);
  }
}

function gitErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function compactOutput(output: string): string {
  const limit = 12_000;
  return output.length <= limit ? output : `${output.slice(0, limit)}\n… output truncated by Guillermo`;
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  return candidate === directory || candidate.startsWith(`${directory}${path.sep}`);
}
