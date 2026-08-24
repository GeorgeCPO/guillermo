import path from "node:path";
import { parseArgs } from "node:util";

export interface CliOptions {
  repo: string;
  task: string;
  model?: string;
  maxSteps?: number;
  branch?: string;
  prTitle?: string;
  baseBranch?: string;
}

export type CliParseResult =
  | { kind: "help"; text: string }
  | { kind: "options"; options: CliOptions };

export const HELP_TEXT = `Usage: npm run dev -- --repo <path> --task <description> [options]

Options:
  --repo <path>          Repository to change (required)
  --task <description>   Change to make (required)
  --branch <name>        Working branch name
  --base <branch>        Pull-request base branch
  --pr-title <title>     Pull-request title
  --model <model>        OpenAI model override
  --max-steps <count>    Maximum agent steps (1-50)
  -h, --help             Show this help`;

const OPTION_DEFINITIONS = {
  repo: { type: "string" },
  task: { type: "string" },
  branch: { type: "string" },
  base: { type: "string" },
  "pr-title": { type: "string" },
  model: { type: "string" },
  "max-steps": { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export function parseCli(args: readonly string[], cwd: string): CliParseResult {
  const { values, tokens } = parseArgs({
    args: [...args],
    options: OPTION_DEFINITIONS,
    strict: true,
    allowPositionals: false,
    tokens: true,
  });

  rejectRepeatedOptions(tokens);

  if (values.help) {
    return { kind: "help", text: HELP_TEXT };
  }

  if (!values.repo) {
    throw new Error("Missing required option: --repo");
  }
  if (!values.task) {
    throw new Error("Missing required option: --task");
  }

  const maxSteps = parseMaxSteps(values["max-steps"]);
  return {
    kind: "options",
    options: {
      repo: path.resolve(cwd, values.repo),
      task: values.task,
      model: values.model,
      maxSteps,
      branch: values.branch,
      prTitle: values["pr-title"],
      baseBranch: values.base,
    },
  };
}

function rejectRepeatedOptions(tokens: ReturnType<typeof parseArgs>["tokens"]): void {
  const seen = new Set<string>();
  for (const token of tokens ?? []) {
    if (token.kind !== "option") continue;
    if (seen.has(token.name)) {
      throw new Error(`Option may only be specified once: --${token.name}`);
    }
    seen.add(token.name);
  }
}

function parseMaxSteps(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const maxSteps = Number(value);
  if (!Number.isSafeInteger(maxSteps)) {
    throw new Error("--max-steps must be an integer.");
  }
  return maxSteps;
}
