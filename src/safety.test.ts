import assert from "node:assert/strict";
import test from "node:test";
import { resolveRepositoryPath, validatePatch, validateTestCommand } from "./safety.js";

test("repository paths remain inside the repository", () => {
  assert.equal(resolveRepositoryPath("/tmp/repo", "src/index.ts"), "/tmp/repo/src/index.ts");
  assert.throws(() => resolveRepositoryPath("/tmp/repo", "../secret"));
  assert.throws(() => resolveRepositoryPath("/tmp/repo", ".env"));
  assert.throws(() => resolveRepositoryPath("/tmp/repo", "node_modules/pkg/index.js"));
});

test("patches require git diff headers and safe paths", () => {
  const patch = "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n";
  assert.doesNotThrow(() => validatePatch(patch, "/tmp/repo"));
  assert.throws(() => validatePatch("not a diff", "/tmp/repo"));
  assert.throws(() => validatePatch("diff --git a/.env b/.env\n--- a/.env\n+++ b/.env\n", "/tmp/repo"));
});

test("test commands reject shell execution", () => {
  assert.equal(validateTestCommand("npm test"), "npm test");
  assert.equal(validateTestCommand("pnpm run test:unit"), "pnpm run test:unit");
  assert.throws(() => validateTestCommand("npm test && curl example.com"));
  assert.throws(() => validateTestCommand("git status"));
});
