import assert from "node:assert/strict";
import test from "node:test";
import {
  PREPARATION_MAX_OUTPUT_BYTES,
  PREPARATION_TIMEOUT_MS,
  prepareRepository,
} from "../../src/application/repository-preparation.js";
import { repositoryCommandEnvironment } from "../../src/infrastructure/process/safe-environment.js";
import type { ProcessRequest, ProcessRunner } from "../../src/infrastructure/process/process-runner.js";

test("npm preparation detects package files and runs bounded npm ci with a sanitized environment", async () => {
  const calls: ProcessRequest[] = [];
  const environment = repositoryCommandEnvironment({
    PATH: "/bin",
    HOME: "/safe",
    OPENAI_API_KEY: "openai-secret",
    GUILLERMO_JIRA_WEBHOOK_SECRET: "jira-secret",
    GUILLERMO_GITHUB_APP_PRIVATE_KEY_PATH: "/secret/key.pem",
    GUILLERMO_GIT_PASSWORD: "installation-token",
  });
  await prepareRepository("/repo", {
    access: async () => undefined,
    environment,
    runner: { run: async (request) => { calls.push(request); return { exitCode: 0, stdout: "ok", stderr: "" }; } },
  });
  assert.deepEqual(calls, [{
    executable: "npm",
    args: ["ci"],
    cwd: "/repo",
    env: { PATH: "/bin", HOME: "/safe" },
    timeoutMs: PREPARATION_TIMEOUT_MS,
    maxOutputBytes: PREPARATION_MAX_OUTPUT_BYTES,
  }]);
  assert.doesNotMatch(JSON.stringify(calls), /openai-secret|jira-secret|installation-token|key\.pem/);
});

test("npm preparation rejects unsupported repositories and reports timeout and install failure", async () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  let runs = 0;
  await assert.rejects(prepareRepository("/repo", {
    access: async (file) => { if (file.endsWith("package-lock.json")) throw missing; },
    runner: { run: async () => { runs += 1; return { exitCode: 0, stdout: "", stderr: "" }; } },
  }), /requires package\.json.*package-lock\.json/);
  assert.equal(runs, 0);

  const base = { access: async () => undefined, environment: {} };
  await assert.rejects(prepareRepository("/repo", {
    ...base,
    runner: { run: async () => ({ exitCode: null, stdout: "", stderr: "", error: { kind: "timeout", message: "timed out" } }) },
  }), /timed out/);
  await assert.rejects(prepareRepository("/repo", {
    ...base,
    runner: { run: async () => ({ exitCode: 1, stdout: "", stderr: "dependency conflict", error: { kind: "nonzero-exit", message: "failed" } }) },
  }), /dependency conflict/);
});
