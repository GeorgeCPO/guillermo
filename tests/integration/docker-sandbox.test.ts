import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DockerSandboxProvider } from "../../src/infrastructure/docker/docker-sandbox.js";

const runDockerTests = process.env.GUILLERMO_RUN_DOCKER_TESTS === "1";

test("Docker worker isolates a real repository test command", { skip: !runDockerTests }, async (t) => {
  const workspace = await mkdtemp(path.join(tmpdir(), "guillermo-docker-integration-"));
  const sibling = await mkdtemp(path.join(tmpdir(), "guillermo-sibling-secret-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  t.after(() => rm(sibling, { recursive: true, force: true }));
  await mkdir(path.join(workspace, ".git"));
  await writeFile(path.join(sibling, "secret.txt"), "sibling-secret");
  await writeFile(path.join(workspace, "verify-metadata.mjs"), `
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1000);
    try {
      await fetch("http://169.254.169.254/latest/api/token", {
        method: "PUT",
        headers: { "X-aws-ec2-metadata-token-ttl-seconds": "60" },
        signal: controller.signal,
      });
      throw new Error("EC2 metadata endpoint was reachable from a networked worker");
    } catch (error) {
      if (error instanceof Error && error.message.includes("was reachable")) throw error;
    } finally { clearTimeout(timer); }
  `);
  await writeFile(path.join(workspace, "package.json"), JSON.stringify({
    name: "sandbox-fixture",
    private: true,
    scripts: { preinstall: "node verify-metadata.mjs", test: "node verify.mjs" },
  }));
  await writeFile(path.join(workspace, "package-lock.json"), JSON.stringify({
    name: "sandbox-fixture", lockfileVersion: 3, requires: true,
    packages: { "": { name: "sandbox-fixture", hasInstallScript: true } },
  }));
  await writeFile(path.join(workspace, "verify.mjs"), `
    import assert from "node:assert/strict";
    import { existsSync, writeFileSync } from "node:fs";
    import { networkInterfaces } from "node:os";
    assert.notEqual(process.getuid(), 0);
    assert.equal(process.env.OPENAI_API_KEY, undefined);
    assert.equal(process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI, undefined);
    assert.equal(process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI, undefined);
    assert.deepEqual(Object.keys(networkInterfaces()), ["lo"]);
    assert.equal(existsSync("/var/run/docker.sock"), false);
    assert.equal(existsSync("/run/secrets/github-app.pem"), false);
    assert.equal(existsSync(${JSON.stringify(sibling)}), false);
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
  const preparation = await provider.forWorkspace(workspace).preparationRunner.run({
    executable: "npm",
    args: ["ci"],
    cwd: workspace,
    timeoutMs: 60_000,
    maxOutputBytes: 100_000,
  });
  assert.equal(preparation.exitCode, 0, `${preparation.stdout}\n${preparation.stderr}`);
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
