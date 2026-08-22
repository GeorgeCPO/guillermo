import path from "node:path";

// These rules are intentionally more restrictive than Git. They define the
// small subset of repository content the agent is allowed to inspect or edit.
const BLOCKED_PATH_SEGMENTS = new Set([".git", "node_modules", ".env", ".guillermo"]);
const BLOCKED_FILENAMES = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);
const SAFE_TEST_ARGUMENT = /^(?:--[A-Za-z][A-Za-z0-9-]*(?:=[A-Za-z0-9_./:@,-]+)?|[A-Za-z0-9_./:@,-]+)$/;
const TEST_SCRIPT = /^test(?:[:_-][A-Za-z0-9_-]+)*$/;
const BLOCKED_TEST_ARGUMENTS = new Set(["--watch", "--watchAll", "--ui"]);

export function resolveRepositoryPath(repositoryRoot: string, candidate: string): string {
  if (!candidate || path.isAbsolute(candidate)) {
    throw new Error("Paths must be non-empty and relative to the repository root.");
  }

  const normalized = path.posix.normalize(candidate.replaceAll("\\", "/"));
  if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Paths cannot leave the repository root.");
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || BLOCKED_PATH_SEGMENTS.has(segment)) || BLOCKED_FILENAMES.has(segments.at(-1) ?? "")) {
    throw new Error(`Path is blocked by Guillermo's local safety policy: ${candidate}`);
  }

  const resolved = path.resolve(repositoryRoot, normalized);
  if (!resolved.startsWith(`${repositoryRoot}${path.sep}`)) {
    throw new Error("Path resolution escaped the repository root.");
  }
  return resolved;
}

export function validatePatch(patch: string, repositoryRoot: string): void {
  if (!patch || patch.includes("\0") || !patch.startsWith("diff --git ")) {
    throw new Error("apply_patch expects a non-binary unified Git diff without a preamble.");
  }
  if (/^(?:GIT binary patch|Binary files |similarity index |rename (?:from|to) |copy (?:from|to) |old mode |new mode )/m.test(patch)) {
    throw new Error("Binary, rename, copy, and mode-only patches are not allowed.");
  }

  // Parse each file section ourselves instead of trusting only `git apply`:
  // Git accepts many useful features (renames, modes, binary data) that this
  // agent intentionally does not support.
  const sections = patch.split(/(?=^diff --git )/m);
  for (const section of sections) validatePatchSection(section, repositoryRoot);
}

function validatePatchSection(section: string, repositoryRoot: string): void {
  const lines = section.split("\n");
  const diffHeader = /^diff --git a\/([^\s]+) b\/([^\s]+)$/.exec(lines[0] ?? "");
  if (!diffHeader || diffHeader[1] !== diffHeader[2]) {
    throw new Error("Each patch section must modify exactly one unquoted repository-relative path.");
  }
  resolveRepositoryPath(repositoryRoot, diffHeader[1]);

  const oldHeader = lines.find((line) => line.startsWith("--- "));
  const newHeader = lines.find((line) => line.startsWith("+++ "));
  const expectedOld = `--- a/${diffHeader[1]}`;
  const expectedNew = `+++ b/${diffHeader[1]}`;
  if (!oldHeader || !newHeader || ![expectedOld, "--- /dev/null"].includes(oldHeader) || ![expectedNew, "+++ /dev/null"].includes(newHeader)) {
    throw new Error("Patch file headers must exactly match their diff header.");
  }
  if (oldHeader === "--- /dev/null" && newHeader === "+++ /dev/null") {
    throw new Error("A patch cannot add and delete the same file.");
  }
  if (!lines.some((line) => line.startsWith("@@ "))) {
    throw new Error("Each patch section must contain a unified-diff hunk.");
  }

  for (const line of lines) {
    if (line.startsWith("new file mode ") && line !== "new file mode 100644") {
      throw new Error("Patches may only add regular, non-executable files.");
    }
    if (line.startsWith("deleted file mode ") && line !== "deleted file mode 100644") {
      throw new Error("Patches may only delete regular, non-executable files.");
    }
  }
}

export function validateTestCommand(command: string): string {
  return parseTestCommand(command).join(" ");
}

export function parseTestCommand(command: string): string[] {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("A test command is required.");
  if (/[|;&><`$\\()'"\n\r]/.test(trimmed)) {
    throw new Error("Test commands cannot contain shell syntax, quoting, or substitutions.");
  }

  const parts = trimmed.split(/\s+/);
  const [runner, action, ...remaining] = parts;
  if (!runner || !action || !["npm", "pnpm", "yarn", "bun"].includes(runner)) {
    throw new Error("Only npm, pnpm, yarn, and bun test commands are allowed.");
  }

  // Package managers have general-purpose commands. Restricting them to test
  // scripts keeps the model from using a package manager as a shell surrogate.
  let testArguments: string[];
  if (runner === "bun") {
    if (action !== "test") throw new Error("bun may only run its test command.");
    testArguments = remaining;
  } else if (action === "test") {
    testArguments = afterDelimiter(remaining);
  } else if (action === "run" && remaining[0] && TEST_SCRIPT.test(remaining[0])) {
    testArguments = afterDelimiter(remaining.slice(1));
  } else {
    throw new Error("Only test or test-prefixed package scripts are allowed.");
  }

  for (const argument of testArguments) {
    if (!SAFE_TEST_ARGUMENT.test(argument) || BLOCKED_TEST_ARGUMENTS.has(argument.split("=", 1)[0]) || argument.startsWith("/") || argument.includes("=/") || /(?:^|[=\\/])\.\.(?:[\\/]|$)/.test(argument) || argument.includes("node_modules")) {
      throw new Error("Test arguments must be simple, repository-local selectors or flags.");
    }
  }
  return parts;
}

function afterDelimiter(parts: string[]): string[] {
  if (parts.length === 0) return [];
  if (parts[0] !== "--") {
    throw new Error("Test arguments must follow a -- delimiter.");
  }
  if (parts.length === 1) throw new Error("The -- delimiter requires at least one test argument.");
  return parts.slice(1);
}
