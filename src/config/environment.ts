import process from "node:process";

export type EnvironmentFileLoader = () => void;

export function loadEnvironmentFile(load: EnvironmentFileLoader = () => process.loadEnvFile()): void {
  try {
    load();
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }
}
