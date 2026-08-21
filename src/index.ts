import path from "node:path";
import process from "node:process";
import { access, realpath } from "node:fs/promises";
import { runAgent } from "./agent.js";
import { loadConfig } from "./config.js";
import { Repository } from "./repository.js";

interface CliOptions {
  repo: string;
  task: string;
  model?: string;
  maxSteps?: number;
}

async function main(): Promise<void> {
  loadEnvironment();
  const options = parseCli(process.argv.slice(2));
  await access(options.repo);
  const root = await realpath(options.repo);
  const repository = new Repository(root);
  await repository.assertGitRepository();

  const report = await runAgent(loadConfig({ model: options.model, maxSteps: options.maxSteps }), repository, options.task);
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

function parseCli(args: string[]): CliOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) usage();
    values.set(flag.slice(2), value);
  }
  const repo = values.get("repo");
  const task = values.get("task");
  if (!repo || !task) usage();
  const maxStepsValue = values.get("max-steps");
  const maxSteps = maxStepsValue ? Number(maxStepsValue) : undefined;
  if (maxStepsValue && !Number.isSafeInteger(maxSteps)) usage();
  return { repo: path.resolve(repo), task, model: values.get("model"), maxSteps };
}

function usage(): never {
  throw new Error("Usage: npm run dev -- --repo /absolute/path/to/repo --task \"Describe the change\" [--model model] [--max-steps 12]");
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
