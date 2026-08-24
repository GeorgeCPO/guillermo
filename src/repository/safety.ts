import path from "node:path";

const BLOCKED_PATH_SEGMENTS = new Set([".git", "node_modules", ".env", ".guillermo"]);
const BLOCKED_FILENAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);

export function resolveRepositoryPath(repositoryRoot: string, candidate: string): string {
  if (!candidate || path.isAbsolute(candidate)) {
    throw new Error("Paths must be non-empty and relative to the repository root.");
  }

  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Paths cannot leave the repository root.");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => BLOCKED_PATH_SEGMENTS.has(segment)) || BLOCKED_FILENAMES.has(segments.at(-1) ?? "")) {
    throw new Error(`Path is blocked by Guillermo's local safety policy: ${candidate}`);
  }

  const resolved = path.resolve(repositoryRoot, normalized);
  if (!resolved.startsWith(`${repositoryRoot}${path.sep}`) && resolved !== repositoryRoot) {
    throw new Error("Path resolution escaped the repository root.");
  }
  return resolved;
}

export function validatePatch(patch: string, repositoryRoot: string): void {
  if (!patch.includes("diff --git ")) {
    throw new Error("apply_patch expects a unified Git diff.");
  }

  const fileHeaders = patch.matchAll(/^(?:---|\+\+\+) [ab]\/(.+)$/gm);
  const files = [...fileHeaders].map((match) => match[1]).filter((file) => file !== "/dev/null");
  if (files.length === 0) {
    throw new Error("The patch did not contain any valid file headers.");
  }
  for (const file of files) resolveRepositoryPath(repositoryRoot, file);
}

export function validateTestCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("A test command is required.");
  if (/[|;&><`$\\()]/.test(trimmed)) {
    throw new Error("Test commands cannot contain shell operators or substitutions.");
  }

  const parts = trimmed.split(/\s+/);
  const [runner, action] = parts;
  const valid = (runner === "npm" && (action === "test" || action === "run"))
    || (runner === "pnpm" && (action === "test" || action === "run"))
    || (runner === "yarn" && (action === "test" || action === "run"))
    || (runner === "bun" && action === "test");
  if (!valid) {
    throw new Error("Only npm/pnpm/yarn/bun test commands are allowed.");
  }
  return trimmed;
}
