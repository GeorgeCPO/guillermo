import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  isSafeBranchName,
  isValidRepositoryName,
  isValidRepositoryOwner,
  repositoryHttpsUrl,
  type RepositoryTarget,
} from "./repository-target.js";
import { AskPassGitAuthentication, GIT_ASKPASS_SCRIPT, type GitAuthentication } from "../infrastructure/git/git-authentication.js";
import {
  assertProcessSuccess,
  defaultProcessRunner,
  type ProcessResult,
  type ProcessRunner,
} from "../infrastructure/process/process-runner.js";
import type { InstallationTokenProvider } from "../integrations/github/github-app.js";

const CLONE_TIMEOUT_MS = 5 * 60 * 1_000;
const CLONE_MAX_OUTPUT_BYTES = 100_000;

export interface ManagedWorkspace {
  root: string;
  authentication: GitAuthentication;
}

export interface WorkspaceFileSystem {
  mkdtemp(prefix: string): Promise<string>;
  writeFile(path: string, contents: string, options: { mode: number }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  realpath(path: string): Promise<string>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
}

export interface ManagedWorkspaceDependencies {
  fileSystem: WorkspaceFileSystem;
  runner: ProcessRunner;
  temporaryRoot: string;
}

const defaultDependencies: ManagedWorkspaceDependencies = {
  fileSystem: { mkdtemp, writeFile, chmod, realpath, rm },
  runner: defaultProcessRunner,
  temporaryRoot: tmpdir(),
};

export class ManagedWorkspaceProvider {
  private readonly dependencies: ManagedWorkspaceDependencies;

  public constructor(
    private readonly tokens: InstallationTokenProvider,
    overrides: Partial<ManagedWorkspaceDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...overrides };
  }

  async withWorkspace<T>(
    repository: RepositoryTarget,
    baseBranch: string,
    operation: (workspace: ManagedWorkspace) => Promise<T>,
  ): Promise<T> {
    assertRemoteInput(repository, baseBranch);
    const workspaceRoot = await this.dependencies.fileSystem.mkdtemp(path.join(this.dependencies.temporaryRoot, "guillermo-job-"));
    try {
      const checkoutPath = path.join(workspaceRoot, "checkout");
      const authentication = new AskPassGitAuthentication(this.tokens, async () => {
        const helperRoot = await this.dependencies.fileSystem.mkdtemp(path.join(workspaceRoot, "auth-"));
        const helperPath = path.join(helperRoot, "git-askpass.sh");
        await this.dependencies.fileSystem.writeFile(helperPath, GIT_ASKPASS_SCRIPT, { mode: 0o700 });
        await this.dependencies.fileSystem.chmod(helperPath, 0o700);
        return {
          path: helperPath,
          cleanup: () => this.dependencies.fileSystem.rm(helperRoot, { recursive: true, force: true }),
        };
      });
      const result = await authentication.withEnvironment((env) => this.dependencies.runner.run({
          executable: "git",
          args: ["clone", "--branch", baseBranch, "--single-branch", "--depth", "1", repositoryHttpsUrl(repository), checkoutPath],
          cwd: workspaceRoot,
          env,
          timeoutMs: CLONE_TIMEOUT_MS,
          maxOutputBytes: CLONE_MAX_OUTPUT_BYTES,
        }));
      assertProcessSuccess(redactProcessResult(result, authentication), "GitHub repository clone");
      const root = await this.dependencies.fileSystem.realpath(checkoutPath);
      return await operation({ root, authentication });
    } finally {
      await this.dependencies.fileSystem.rm(workspaceRoot, { recursive: true, force: true });
    }
  }
}

function assertRemoteInput(repository: RepositoryTarget, baseBranch: string): void {
  if (!isValidRepositoryOwner(repository.owner) || !isValidRepositoryName(repository.name)) {
    throw new Error("Invalid trusted GitHub repository identity.");
  }
  if (!isSafeBranchName(baseBranch)) throw new Error("Invalid trusted Git base branch.");
}

function redactProcessResult(result: ProcessResult, authentication: GitAuthentication): ProcessResult {
  return {
    ...result,
    stdout: authentication.redact(result.stdout),
    stderr: authentication.redact(result.stderr),
    ...(result.error ? { error: { ...result.error, message: authentication.redact(result.error.message) } } : {}),
  };
}
