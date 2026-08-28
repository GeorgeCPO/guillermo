import assert from "node:assert/strict";
import test from "node:test";
import { loadWebhookRuntimeConfig } from "../../src/config/webhook-config.js";

const valid = {
  GUILLERMO_GITHUB_APP_ID: "123",
  GUILLERMO_GITHUB_APP_INSTALLATION_ID: "456",
  GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH: "/run/secrets/github-app.pem",
  GUILLERMO_GIT_AUTHOR_NAME: "Guillermo Bot",
  GUILLERMO_GIT_AUTHOR_EMAIL: "guillermo@example.test",
  GUILLERMO_WORKSPACE_ROOT: "/var/lib/guillermo/workspaces",
};

test("webhook runtime configuration validates GitHub App and commit author settings", () => {
  assert.deepEqual(loadWebhookRuntimeConfig(valid), {
    githubApp: { appId: "123", installationId: "456", privateKeyPath: "/run/secrets/github-app.pem" },
    commitAuthor: { name: "Guillermo Bot", email: "guillermo@example.test" },
    workspaceRoot: "/var/lib/guillermo/workspaces",
  });
  for (const [key, value] of [
    ["GUILLERMO_GITHUB_APP_ID", "0"],
    ["GUILLERMO_GITHUB_APP_INSTALLATION_ID", "1;echo"],
    ["GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH", "relative.pem"],
    ["GUILLERMO_GIT_AUTHOR_NAME", "Bot\nInjected"],
    ["GUILLERMO_GIT_AUTHOR_EMAIL", "not-an-email"],
    ["GUILLERMO_WORKSPACE_ROOT", "relative/workspaces"],
    ["GUILLERMO_WORKSPACE_ROOT", "/var/lib/../tmp"],
    ["GUILLERMO_WORKSPACE_ROOT", "/"],
    ["GUILLERMO_WORKSPACE_ROOT", "/var/lib/bad,source"],
  ] as const) {
    assert.throws(() => loadWebhookRuntimeConfig({ ...valid, [key]: value }), new RegExp(key));
  }
});

test("webhook workspace root is required rather than silently using a container-private temporary directory", () => {
  const { GUILLERMO_WORKSPACE_ROOT: _removed, ...missing } = valid;
  assert.throws(() => loadWebhookRuntimeConfig(missing), /GUILLERMO_WORKSPACE_ROOT/);
});
