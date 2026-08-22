import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DisposableWorktree } from "./execution.js";
import { Repository } from "./repository.js";

const execFileAsync = promisify(execFile);

test("approved execution can patch and test a fixture without changing its source checkout", async (t) => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "guillermo-fixture-"));
  t.after(async () => { await rm(fixtureRoot, { recursive: true, force: true }); });
  await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({
    private: true,
    scripts: { test: "node --test" },
  }));
  await writeFile(path.join(fixtureRoot, "message.js"), "export const message = 'before';\n");
  await writeFile(path.join(fixtureRoot, "message.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { message } from './message.js';",
    "test('message is updated', () => assert.equal(message, 'after'));",
    "",
  ].join("\n"));
  await git(fixtureRoot, ["init"]);
  await git(fixtureRoot, ["config", "user.email", "fixture@example.test"]);
  await git(fixtureRoot, ["config", "user.name", "Fixture"]);
  await git(fixtureRoot, ["add", "."]);
  await git(fixtureRoot, ["commit", "-m", "fixture"]);

  const worktree = await DisposableWorktree.create(fixtureRoot);
  try {
    const repository = new Repository(worktree.root);
    const patch = [
      "diff --git a/message.js b/message.js",
      "--- a/message.js",
      "+++ b/message.js",
      "@@ -1 +1 @@",
      "-export const message = 'before';",
      "+export const message = 'after';",
      "",
    ].join("\n");
    await repository.checkPatch(patch);
    assert.equal(await repository.diff(), "No uncommitted changes.");
    await repository.applyPatch(patch);
    const result = await repository.runTests("npm test");
    assert.equal(result.exitCode, 0, result.output);
    assert.match(await repository.diff(), /\+export const message = 'after'/);
    assert.deepEqual(await repository.changedFiles(), [" M message.js"]);
    assert.equal(await readFile(path.join(fixtureRoot, "message.js"), "utf8"), "export const message = 'before';\n");
  } finally {
    const worktreePath = worktree.root;
    await worktree.dispose();
    await assert.rejects(readFile(worktreePath, "utf8"));
  }
});

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}
