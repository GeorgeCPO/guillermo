import assert from "node:assert/strict";
import test from "node:test";
import { deriveDefaultBranchName } from "./branch.js";

test("default branch names are deterministic, readable, and Git-valid", () => {
  assert.equal(deriveDefaultBranchName("Add URL parser tests & fix café bug!"), "guillermo/add-url-parser-tests-fix-cafe-bug");
  assert.equal(deriveDefaultBranchName("🚀"), "guillermo/task");
  assert.equal(deriveDefaultBranchName("A very long task ".repeat(10)).length <= "guillermo/".length + 60, true);
});
