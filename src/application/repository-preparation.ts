import { access } from "node:fs/promises";
import path from "node:path";
import {
  assertProcessSuccess,
  defaultProcessRunner,
  type ProcessRunner,
} from "../infrastructure/process/process-runner.js";
import { repositoryCommandEnvironment } from "../infrastructure/process/safe-environment.js";

export const PREPARATION_TIMEOUT_MS = 10 * 60 * 1_000;
export const PREPARATION_MAX_OUTPUT_BYTES = 250_000;

export interface RepositoryPreparationDependencies {
  access(path: string): Promise<void>;
  runner: ProcessRunner;
  environment: Readonly<Record<string, string>>;
}

const defaults: RepositoryPreparationDependencies = {
  access,
  runner: defaultProcessRunner,
  environment: repositoryCommandEnvironment(),
};

export async function prepareRepository(
  root: string,
  overrides: Partial<RepositoryPreparationDependencies> = {},
): Promise<void> {
  const dependencies = { ...defaults, ...overrides };
  if (!await exists(dependencies.access, path.join(root, "package.json"))
    || !await exists(dependencies.access, path.join(root, "package-lock.json"))) {
    throw new Error("Unsupported repository: Stage 9.5 requires package.json and a committed package-lock.json.");
  }

  const result = await dependencies.runner.run({
    executable: "npm",
    args: ["ci"],
    cwd: root,
    env: dependencies.environment,
    timeoutMs: PREPARATION_TIMEOUT_MS,
    maxOutputBytes: PREPARATION_MAX_OUTPUT_BYTES,
  });
  assertProcessSuccess(result, "Repository preparation (npm ci)");
}

async function exists(check: (path: string) => Promise<void>, file: string): Promise<boolean> {
  try {
    await check(file);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
