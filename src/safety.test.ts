import assert from "node:assert/strict";
import test from "node:test";
import { parseCli } from "./cli.js";
import { resolveRepositoryPath, validatePatch, validateTestCommand } from "./safety.js";

test("repository paths remain inside the repository", () => {
  assert.equal(resolveRepositoryPath("/tmp/repo", "src/index.ts"), "/tmp/repo/src/index.ts");
  assert.throws(() => resolveRepositoryPath("/tmp/repo", "../secret"));
  assert.throws(() => resolveRepositoryPath("/tmp/repo", ".env"));
  assert.throws(() => resolveRepositoryPath("/tmp/repo", "node_modules/pkg/index.js"));
  assert.throws(() => resolveRepositoryPath("/tmp/repo", "."));
  assert.throws(() => resolveRepositoryPath("/tmp/repo", "src/../.git/config"));
});

test("patches require git diff headers and safe paths", () => {
  const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  assert.doesNotThrow(() => validatePatch(patch, "/tmp/repo"));
  assert.throws(() => validatePatch("not a diff", "/tmp/repo"));
  assert.throws(() => validatePatch("diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n", "/tmp/repo"));
  assert.throws(() => validatePatch("diff --git a/src/a.ts b/src/b.ts\n--- a/src/a.ts\n+++ b/src/b.ts\n@@ -1 +1 @@\n-old\n+new\n", "/tmp/repo"));
  assert.throws(() => validatePatch("diff --git a/src/a.ts b/src/a.ts\nold mode 100644\nnew mode 100755\n", "/tmp/repo"));
  assert.throws(() => validatePatch("diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\nGIT binary patch\n", "/tmp/repo"));
});

test("test commands reject shell execution", () => {
  assert.equal(validateTestCommand("npm test"), "npm test");
  assert.equal(validateTestCommand("pnpm run test:unit"), "pnpm run test:unit");
  assert.equal(validateTestCommand("npm test -- --runInBand"), "npm test -- --runInBand");
  assert.throws(() => validateTestCommand("npm test && curl example.com"));
  assert.throws(() => validateTestCommand("git status"));
  assert.throws(() => validateTestCommand("npm run build"));
  assert.throws(() => validateTestCommand("npm test -- ../other"));
  assert.throws(() => validateTestCommand("npm test -- --prefix=/tmp"));
  assert.throws(() => validateTestCommand("npm test -- --watch"));
  assert.throws(() => validateTestCommand("npm test -- --watch;curl"));
});

test("CLI defaults to dry-run and requires an explicit approval flag", () => {
  const base = ["--repo", "/tmp/repo", "--task", "Update the message"];
  assert.equal(parseCli(base).mode, "dry-run");
  assert.equal(parseCli([...base, "--dry-run"]).mode, "dry-run");
  assert.equal(parseCli([...base, "--approve"]).mode, "approved");
  assert.throws(() => parseCli([...base, "--approve", "--dry-run"]));
  assert.throws(() => parseCli([...base, "--unknown", "value"]));
  assert.throws(() => parseCli([...base, "--repo", "/tmp/other"]));
});
