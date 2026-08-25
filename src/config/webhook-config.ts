import path from "node:path";

export interface GitHubAppConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export interface GitCommitAuthor {
  name: string;
  email: string;
}

export interface WebhookRuntimeConfig {
  githubApp: GitHubAppConfig;
  commitAuthor: GitCommitAuthor;
}

export function loadWebhookRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): WebhookRuntimeConfig {
  const appId = positiveInteger(environment.GUILLERMO_GITHUB_APP_ID, "GUILLERMO_GITHUB_APP_ID");
  const installationId = positiveInteger(
    environment.GUILLERMO_GITHUB_APP_INSTALLATION_ID,
    "GUILLERMO_GITHUB_APP_INSTALLATION_ID",
  );
  const privateKeyPath = required(environment, "GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH");
  if (!path.isAbsolute(privateKeyPath)) {
    throw new Error("GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH must be an absolute file path.");
  }
  const name = boundedLine(required(environment, "GUILLERMO_GIT_AUTHOR_NAME"), "GUILLERMO_GIT_AUTHOR_NAME", 100);
  const email = boundedLine(required(environment, "GUILLERMO_GIT_AUTHOR_EMAIL"), "GUILLERMO_GIT_AUTHOR_EMAIL", 254);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("GUILLERMO_GIT_AUTHOR_EMAIL must be a valid email address.");
  }
  return { githubApp: { appId, installationId, privateKeyPath: path.resolve(privateKeyPath) }, commitAuthor: { name, email } };
}

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for the Jira webhook server.`);
  return value;
}

function positiveInteger(value: string | undefined, name: string): string {
  if (!value || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function boundedLine(value: string, name: string, maximum: number): string {
  if (value.trim() !== value || value.length > maximum || /[\r\n\0]/.test(value)) {
    throw new Error(`${name} must be a non-empty single-line value of at most ${maximum} characters.`);
  }
  return value;
}
