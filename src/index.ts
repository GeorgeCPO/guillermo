import process from "node:process";
import { access, realpath } from "node:fs/promises";
import { runAgent } from "./agent.js";
import { parseCli } from "./cli.js";
import { loadConfig } from "./config.js";
import { DisposableWorktree } from "./execution.js";
import { Repository } from "./repository.js";

async function main(): Promise<void> {
  loadEnvironment();
  const options = parseCli(process.argv.slice(2));
  await access(options.repo);
  const root = await realpath(options.repo);
  const sourceRepository = new Repository(root);
  await sourceRepository.assertGitRepository();
  const worktree = await DisposableWorktree.create(root);
  const repository = new Repository(worktree.root);
  let report: Awaited<ReturnType<typeof runAgent>>;
  try {
    report = await runAgent(
      loadConfig({ model: options.model, maxSteps: options.maxSteps }),
      repository,
      options.task,
    );
  } finally {
    // The report is collected by runAgent before this point; never leave a
    // discarded execution checkout behind if the model or a test throws.
    await worktree.dispose();
  }
  console.log(renderReport(report));
}

function loadEnvironment(): void {
  try {
    process.loadEnvFile();
  } catch (error: unknown) {
    if (!(error instanceof Error) || !isMissingEnvFile(error)) throw error;
  }
}

function isMissingEnvFile(error: Error): boolean {
  return "code" in error && error.code === "ENOENT";
}

function renderReport(report: Awaited<ReturnType<typeof runAgent>>): string {
  const tests = report.testRuns.length === 0
    ? "No tests were run."
    : report.testRuns.map(({ command, result }) => `$ ${command}\nexit ${result.exitCode}\n${result.output}`).join("\n\n");
  return [
    "\n=== Guillermo report ===",
    `Summary: ${report.summary}`,
    `\nTool events:\n${report.events.join("\n") || "No tools were called."}`,
    `\nChanged files:\n${report.changedFiles.join("\n") || "No changes."}`,
    `\nTests:\n${tests}`,
    `\nDiff:\n${report.diff}`,
  ].join("\n");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
