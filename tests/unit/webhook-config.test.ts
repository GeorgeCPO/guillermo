import assert from "node:assert/strict";
import test from "node:test";
import { loadWebhookRuntimeConfig } from "../../src/config/webhook-config.js";

const valid = {
  GUILLERMO_GITHUB_APP_ID: "123",
  GUILLERMO_GITHUB_APP_INSTALLATION_ID: "456",
  GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH: "/run/secrets/github-app.pem",
  GUILLERMO_GIT_AUTHOR_NAME: "Guillermo Bot",
  GUILLERMO_GIT_AUTHOR_EMAIL: "guillermo@example.test",
};

test("webhook runtime configuration validates GitHub App and commit author settings", () => {
  assert.deepEqual(loadWebhookRuntimeConfig(valid), {
    githubApp: { appId: "123", installationId: "456", privateKeyPath: "/run/secrets/github-app.pem" },
    commitAuthor: { name: "Guillermo Bot", email: "guillermo@example.test" },
  });
  for (const [key, value] of [
    ["GUILLERMO_GITHUB_APP_ID", "0"],
    ["GUILLERMO_GITHUB_APP_INSTALLATION_ID", "1;echo"],
    ["GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH", "relative.pem"],
    ["GUILLERMO_GIT_AUTHOR_NAME", "Bot\nInjected"],
    ["GUILLERMO_GIT_AUTHOR_EMAIL", "not-an-email"],
  ] as const) {
    assert.throws(() => loadWebhookRuntimeConfig({ ...valid, [key]: value }), new RegExp(key));
  }
});
