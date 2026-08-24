import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ExecaProcessRunner } from "../../src/infrastructure/process/process-runner.js";

async function workingDirectory(t: { after(callback: () => Promise<void>): void }): Promise<string> {
  const cwd = await mkdtemp(path.join(tmpdir(), "guillermo-process-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return cwd;
}

test("ExecaProcessRunner executes an explicit executable and argument array", async (t) => {
  const cwd = await workingDirectory(t);
  const runner = new ExecaProcessRunner();
  const result = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write(JSON.stringify({ args: process.argv.slice(1), cwd: process.cwd() }))", "one;echo", "two words"],
    cwd,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
  assert.deepEqual(JSON.parse(result.stdout), { args: ["one;echo", "two words"], cwd: await realpath(cwd) });
});

test("ExecaProcessRunner normalizes nonzero exits and stderr", async (t) => {
  const cwd = await workingDirectory(t);
  const result = await new ExecaProcessRunner().run({
    executable: process.execPath,
    args: ["-e", "process.stderr.write('failed'); process.exit(7)"],
    cwd,
  });

  assert.equal(result.exitCode, 7);
  assert.equal(result.stderr, "failed");
  assert.equal(result.error?.kind, "nonzero-exit");
});

test("ExecaProcessRunner forwards stdin", async (t) => {
  const cwd = await workingDirectory(t);
  const result = await new ExecaProcessRunner().run({
    executable: process.execPath,
    args: ["-e", "process.stdin.pipe(process.stdout)"],
    cwd,
    input: "patch contents\n",
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "patch contents\n");
});

test("ExecaProcessRunner bounds captured output", async (t) => {
  const cwd = await workingDirectory(t);
  const maxOutputBytes = 1_024;
  const runner = new ExecaProcessRunner();
  const stdoutResult = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(4096))"],
    cwd,
    maxOutputBytes,
  });
  const stderrResult = await runner.run({
    executable: process.execPath,
    args: ["-e", "process.stderr.write('x'.repeat(4096))"],
    cwd,
    maxOutputBytes,
  });

  assert.ok(Buffer.byteLength(stdoutResult.stdout) <= maxOutputBytes);
  assert.ok(Buffer.byteLength(stderrResult.stderr) <= maxOutputBytes);
  assert.equal(stdoutResult.error?.kind, "output-limit");
  assert.equal(stderrResult.error?.kind, "output-limit");
});
