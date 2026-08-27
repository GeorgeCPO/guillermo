import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerSandboxProvider } from "../../src/infrastructure/docker/docker-sandbox.js";

const runDockerTests = process.env.GUILLERMO_RUN_DOCKER_TESTS === "1";

test("Docker worker isolates a real repository test command", { skip: !runDockerTests }, async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "guillermo-docker-integration-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  await mkdir(path.join(workspace, ".git"));
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "sandbox-fixture",
    private: true,
    scripts: { test: "node verify.mjs" },
  }));
  await writeFile(path.join(workspace, "verify.mjs"), `
    import assert from "node:assert/strict";
    import { writeFileSync } from "node:fs";
    import { networkInterfaces } from "node:os";
    assert.notEqual(process.getuid(), 0);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
    writeFileSync("sandbox-output.txt", "isolated");
    assert.throws(() => writeFileSync(".git/host-hook", "blocked"));
  `);

  const provider = new DockerSandboxProvider({
    image: process.env.GUILLERMO_DOCKER_IMAGE ?? "guillermo-worker:latest",
    memoryLimit: "512m",
    cpuLimit: 1,
    pidsLimit: 64,
  });
  await provider.assertReady();
  const result = await provider.forWorkspace(workspace).testRunner.run({
    executable: "npm",
    args: ["test"],
    cwd: workspace,
    env: { OPENAI_API_KEY: "must-not-leak" },
    timeoutMs: 60_000,
    maxOutputBytes: 100_000,
  });

  assert.equal(result.exitCode, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(await readFile(path.join(workspace, "sandbox-output.txt"), "utf8"), "isolated");
  await assert.rejects(readFile(path.join(workspace, ".git", "host-hook")), /ENOENT/);
});
