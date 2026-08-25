import assert from "node:assert/strict";
import test from "node:test";
import { ManagedWorkspaceProvider, type WorkspaceFileSystem } from "../../src/application/managed-workspace.js";
import type { InstallationTokenProvider } from "../../src/integrations/github/github-app.js";
import type { ProcessRequest, ProcessRunner } from "../../src/infrastructure/process/process-runner.js";

function fixture(result: Awaited<ReturnType<ProcessRunner["run"]>> = { exitCode: 0, stdout: "", stderr: "" }) {
  let workspaceSequence = 0;
  let authSequence = 0;
  const removed: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const calls: ProcessRequest[] = [];
  const fileSystem: WorkspaceFileSystem = {
    mkdtemp: async (prefix) => prefix.endsWith("guillermo-job-")
      ? `/tmp/guillermo-job-${++workspaceSequence}`
      : `${prefix}${++authSequence}`,
    writeFile: async (path, contents) => { writes.push({ path, contents }); },
    chmod: async () => undefined,
    realpath: async (path) => `/canonical${path}`,
    rm: async (path) => { removed.push(path); },
  };
  const runner: ProcessRunner = { run: async (request) => { calls.push(request); return result; } };
  const tokens: InstallationTokenProvider = {
    getToken: async () => ({ value: "installation-secret", expiresAt: new Date("2030-01-01T00:00:00Z") }),
  };
  return { provider: new ManagedWorkspaceProvider(tokens, { fileSystem, runner, temporaryRoot: "/tmp" }), removed, writes, calls };
}

test("managed workspaces are unique, clone only the configured branch and repository, and clean up", async () => {
  const { provider, removed, writes, calls } = fixture();
  const roots: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    await provider.withWorkspace({ owner: "my-org", name: "app" }, "main", async ({ root, authentication }) => {
      roots.push(root);
      await authentication.withEnvironment(async (environment) => {
        assert.equal(environment.GUILLERMO_GIT_PASSWORD, "installation-secret");
      });
    });
  }

  assert.equal(new Set(roots).size, 2);
  assert.deepEqual(removed, [
    "/tmp/guillermo-job-1/auth-1", "/tmp/guillermo-job-1/auth-2", "/tmp/guillermo-job-1",
    "/tmp/guillermo-job-2/auth-3", "/tmp/guillermo-job-2/auth-4", "/tmp/guillermo-job-2",
  ]);
  assert.deepEqual(calls[0]?.args, [
    "clone", "--branch", "main", "--single-branch", "--depth", "1",
    "https://github.com/my-org/app.git", "/tmp/guillermo-job-1/checkout",
  ]);
  assert.equal(calls[0]?.args.some((argument) => argument.includes("installation-secret")), false);
  assert.equal(JSON.stringify(calls[0]?.args).includes("x-access-token"), false);
  assert.equal(calls[0]?.env?.GUILLERMO_GIT_PASSWORD, "installation-secret");
  assert.equal(writes.every(({ contents }) => !contents.includes("installation-secret")), true);
});

test("managed workspaces clean up when the operation or clone fails and redact credentials", async () => {
  const operationFixture = fixture();
  await assert.rejects(
    operationFixture.provider.withWorkspace({ owner: "my-org", name: "app" }, "main", async () => { throw new Error("agent failed"); }),
    /agent failed/,
  );
  assert.deepEqual(operationFixture.removed, ["/tmp/guillermo-job-1/auth-1", "/tmp/guillermo-job-1"]);

  const cloneFixture = fixture({
    exitCode: 128,
    stdout: "",
    stderr: "fatal installation-secret",
    error: { kind: "nonzero-exit", message: "failed with installation-secret" },
  });
  let message = "";
  try {
    await cloneFixture.provider.withWorkspace({ owner: "my-org", name: "app" }, "main", async () => undefined);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.doesNotMatch(message, /installation-secret/);
  assert.match(message, /\[REDACTED\]/);
  assert.deepEqual(cloneFixture.removed, ["/tmp/guillermo-job-1/auth-1", "/tmp/guillermo-job-1"]);
});

test("managed workspaces reject untrusted repository and branch values before allocating", async () => {
  const { provider, calls, removed } = fixture();
  await assert.rejects(provider.withWorkspace({ owner: "https:", name: "evil" }, "main", async () => undefined), /identity/);
  await assert.rejects(provider.withWorkspace({ owner: "my-org", name: "app" }, "--upload-pack=evil", async () => undefined), /base branch/);
  assert.deepEqual(calls, []);
  assert.deepEqual(removed, []);
});
