import type { InstallationTokenProvider } from "../../integrations/github/github-app.js";
import { repositoryCommandEnvironment } from "../process/safe-environment.js";

export interface GitAuthentication {
  withEnvironment<T>(operation: (environment: Readonly<Record<string, string>>) => Promise<T>): Promise<T>;
  redact(value: string): string;
}

export interface AskPassHelper {
  path: string;
  cleanup(): Promise<void>;
}

export class AskPassGitAuthentication implements GitAuthentication {
  private readonly seenSecrets = new Set<string>();

  public constructor(
    private readonly tokens: InstallationTokenProvider,
    private readonly createHelper: () => Promise<AskPassHelper>,
    private readonly baseEnvironment: Readonly<Record<string, string>> = repositoryCommandEnvironment(),
  ) {}

  async withEnvironment<T>(operation: (environment: Readonly<Record<string, string>>) => Promise<T>): Promise<T> {
    const token = await this.tokens.getToken();
    this.seenSecrets.add(token.value);
    const helper = await this.createHelper();
    try {
      return await operation({
        ...this.baseEnvironment,
        GIT_ASKPASS: helper.path,
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: "credential.helper",
        GIT_CONFIG_VALUE_0: "",
        GIT_CONFIG_KEY_1: "core.askPass",
        GIT_CONFIG_VALUE_1: helper.path,
        GUILLERMO_GIT_USERNAME: "x-access-token",
        GUILLERMO_GIT_PASSWORD: token.value,
      });
    } finally {
      await helper.cleanup();
    }
  }

  redact(value: string): string {
    let redacted = value;
    for (const secret of this.seenSecrets) redacted = redacted.replaceAll(secret, "[REDACTED]");
    return redacted;
  }
}

export const GIT_ASKPASS_SCRIPT = `#!/bin/sh
case "$1" in
  *Username*) printf '%s\\n' "$GUILLERMO_GIT_USERNAME" ;;
  *) printf '%s\\n' "$GUILLERMO_GIT_PASSWORD" ;;
esac
`;
