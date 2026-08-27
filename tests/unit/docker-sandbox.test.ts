import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxConfig } from "../../src/config/sandbox-config.js";
import { DockerSandboxProvider } from "../../src/infrastructure/docker/docker-sandbox.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/infrastructure/process/process-runner.js";

const config: SandboxConfig = {
  image: "guillermo-worker:test",
  memoryLimit: "768m",
  cpuLimit: 1.5,
  pidsLimit: 128,
};

function fixture(results: ProcessResult[] = []) {
  const calls: ProcessRequest[] = [];
  const runner: ProcessRunner = {
    run: async (request) => {
      calls.push(request);
      return results.shift() ?? { exitCode: 0, stdout: "ok", stderr: "" };
    },
  };
  const provider = new DockerSandboxProvider(config, {
    runner,
    createId: () => "TEST ID",
    uid: 1234,
    gid: 5678,
    controlDirectory: "/controller",
  });
  return { provider, calls };
}

test("Docker sandbox readiness checks the daemon and requires the configured local image", async () => {
  const { provider, calls } = fixture();
  await provider.assertReady();
  assert.deepEqual(calls.map(({ executable, args, cwd }) => ({ executable, args, cwd })), [
    {
      executable: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd: "/controller",
    },
    {
      executable: "docker",
      args: ["image", "inspect", "guillermo-worker:test"],
      cwd: "/controller",
    },
  ]);
});

test("preparation and tests use hardened ephemeral containers with different networks", async () => {
  const { provider, calls } = fixture();
  const sandbox = provider.forWorkspace("/tmp/guillermo-job/checkout");
  await sandbox.preparationRunner.run({
    executable: "npm",
    args: ["ci"],
    cwd: "/tmp/guillermo-job/checkout",
    env: { OPENAI_API_KEY: "must-not-leak", HOME: "/host-home" },
    timeoutMs: 10_000,
    maxOutputBytes: 2_000,
  });
  await sandbox.testRunner.run({
    executable: "npm",
    args: ["test", "--", "--runInBand"],
    cwd: "/tmp/guillermo-job/checkout",
  });

  assert.equal(calls.length, 2);
  const install = calls[0];
  const tests = calls[1];
  assert.equal(install?.executable, "docker");
  assert.equal(install?.cwd, "/controller");
  assert.equal(install?.timeoutMs, 10_000);
  assert.equal(install?.maxOutputBytes, 2_000);
  assert.equal(install?.args.join(" ").includes("--network bridge"), true);
  assert.equal(tests?.args.join(" ").includes("--network none"), true);

  const argumentsText = JSON.stringify(calls.map(({ args }) => args));
  for (const expected of [
    "--read-only",
    "no-new-privileges=true",
    "--cap-drop",
    "--memory",
    "768m",
    "--memory-swap",
    "--cpus",
    "1.5",
    "--pids-limit",
    "128",
    "1234:5678",
    "type=bind,src=/tmp/guillermo-job/checkout,dst=/workspace",
    "type=bind,src=/tmp/guillermo-job/checkout/.git,dst=/workspace/.git,readonly",
    "guillermo-worker:test",
  ]) {
    assert.match(argumentsText, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(argumentsText, /must-not-leak|host-home|OPENAI_API_KEY/);
  assert.deepEqual(install?.args.slice(-3), ["guillermo-worker:test", "npm", "ci"]);
  assert.deepEqual(tests?.args.slice(-4), ["npm", "test", "--", "--runInBand"]);
});

test("sandbox commands fail closed without invoking Docker for an unsupported request", async () => {
  const { provider, calls } = fixture();
  const sandbox = provider.forWorkspace("/tmp/job/checkout");
  const executable = await sandbox.testRunner.run({ executable: "node", args: ["test.js"], cwd: "/tmp/job/checkout" });
  const directory = await sandbox.testRunner.run({ executable: "npm", args: ["test"], cwd: "/tmp/job" });
  assert.equal(executable.error?.kind, "spawn");
  assert.match(executable.error?.message ?? "", /npm commands only/);
  assert.match(directory.error?.message ?? "", /managed workspace root/);
  assert.deepEqual(calls, []);
  assert.throws(() => provider.forWorkspace("relative/checkout"), /absolute path/);
});

test("sandbox providers refuse to map repository execution to root", () => {
  assert.throws(() => new DockerSandboxProvider(config, { uid: 0 }), /non-root user/);
  assert.throws(() => new DockerSandboxProvider(config, { uid: 1234, gid: -1 }), /group ID/);
});

test("a killed Docker client triggers forced cleanup of the named container", async () => {
  const { provider, calls } = fixture([
    { exitCode: null, stdout: "", stderr: "", error: { kind: "timeout", message: "timed out" } },
    { exitCode: 0, stdout: "removed", stderr: "" },
  ]);
  const result = await provider.forWorkspace("/tmp/job/checkout").testRunner.run({
    executable: "npm",
    args: ["test"],
    cwd: "/tmp/job/checkout",
    timeoutMs: 20,
  });
  assert.equal(result.error?.kind, "timeout");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1]?.args, ["container", "rm", "--force", "guillermo-sandbox-test-id"]);
  assert.equal(calls[1]?.signal, undefined);
});

test("sandbox readiness reports daemon and image failures", async () => {
  const daemon = fixture([{ exitCode: null, stdout: "", stderr: "denied", error: { kind: "spawn", message: "denied" } }]);
  await assert.rejects(daemon.provider.assertReady(), /Docker sandbox availability check/);

  const image = fixture([
    { exitCode: 0, stdout: "29", stderr: "" },
    { exitCode: 1, stdout: "", stderr: "missing", error: { kind: "nonzero-exit", message: "missing" } },
  ]);
  await assert.rejects(image.provider.assertReady(), /Docker sandbox image guillermo-worker:test/);
});
