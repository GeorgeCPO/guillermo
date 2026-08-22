import path from "node:path";
import type { ExecutionMode } from "./execution.js";

export interface CliOptions {
  repo: string;
  task: string;
  model?: string;
  maxSteps?: number;
  mode: ExecutionMode;
}

export function parseCli(args: string[]): CliOptions {
  const values = new Map<string, string>();
  let dryRun = false;
  let approved = false;

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (flag === "--approve") {
      approved = true;
      continue;
    }
    if (!flag?.startsWith("--") || !["--repo", "--task", "--model", "--max-steps"].includes(flag)) usage();
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(flag.slice(2))) usage();
    values.set(flag.slice(2), value);
    index += 1;
  }

  const repo = values.get("repo");
  const task = values.get("task");
  if (!repo || !task || (dryRun && approved)) usage();
  const maxStepsValue = values.get("max-steps");
  const maxSteps = maxStepsValue === undefined ? undefined : Number(maxStepsValue);
  if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) usage();
  // Approval is opt-in. An omitted mode is intentionally safe even when this
  // CLI is called from a future automation rather than an interactive shell.
  return { repo: path.resolve(repo), task, model: values.get("model"), maxSteps, mode: approved ? "approved" : "dry-run" };
}

export function usage(): never {
  throw new Error("Usage: npm run dev -- --repo /absolute/path/to/repo --task \"Describe the change\" [--dry-run | --approve] [--model model] [--max-steps 12]");
}
