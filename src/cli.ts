import path from "node:path";

export interface CliOptions {
  repo: string;
  task: string;
  model?: string;
  maxSteps?: number;
}

export function parseCli(args: string[]): CliOptions {
  const values = new Map<string, string>();

  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (!flag?.startsWith("--") || !["--repo", "--task", "--model", "--max-steps"].includes(flag)) usage();
    const value = args[index + 1];
    if (!value || value.startsWith("--") || values.has(flag.slice(2))) usage();
    values.set(flag.slice(2), value);
    index += 1;
  }

  const repo = values.get("repo");
  const task = values.get("task");
  if (!repo || !task) usage();
  const maxStepsValue = values.get("max-steps");
  const maxSteps = maxStepsValue === undefined ? undefined : Number(maxStepsValue);
  if (maxSteps !== undefined && (!Number.isSafeInteger(maxSteps) || maxSteps < 1)) usage();
  return { repo: path.resolve(repo), task, model: values.get("model"), maxSteps };
}

export function usage(): never {
  throw new Error("Usage: npm run dev -- --repo /absolute/path/to/repo --task \"Describe the change\" [--model model] [--max-steps 12]");
}
