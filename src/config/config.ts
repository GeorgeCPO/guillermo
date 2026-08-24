export interface GuillermoConfig {
  apiKey: string;
  model: string;
  maxSteps: number;
}

export const MIN_AGENT_STEPS = 1;
export const MAX_AGENT_STEPS = 50;
const DEFAULT_AGENT_STEPS = 20;
const DEFAULT_MODEL = "gpt-5.6-terra";

export function loadConfig(overrides: Partial<Pick<GuillermoConfig, "model" | "maxSteps">> = {}): GuillermoConfig {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is required. Add it to your environment before running Guillermo.");
  }

  const maxSteps = overrides.maxSteps ?? Number(process.env.GUILLERMO_MAX_STEPS ?? DEFAULT_AGENT_STEPS);
  if (!Number.isSafeInteger(maxSteps) || maxSteps < MIN_AGENT_STEPS || maxSteps > MAX_AGENT_STEPS) {
    throw new Error("maxSteps must be an integer between 1 and 50.");
  }

  return {
    apiKey,
    model: overrides.model ?? process.env.GUILLERMO_MODEL ?? DEFAULT_MODEL,
    maxSteps,
  };
}
