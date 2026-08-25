const COPIED_KEYS = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "TERM", "CI", "SystemRoot", "COMSPEC", "PATHEXT",
] as const;

/** Returns the small, explicit environment exposed to repository-controlled commands. */
export function repositoryCommandEnvironment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const key of COPIED_KEYS) {
    const value = source[key];
    if (value !== undefined) environment[key] = value;
  }
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key.startsWith("LC_")) environment[key] = value;
  }
  return environment;
}
