import assert from "node:assert/strict";
import test from "node:test";
import { loadEnvironmentFile } from "../../src/config/environment.js";

test("loads the environment file when present", () => {
  let calls = 0;
  loadEnvironmentFile(() => { calls += 1; });
  assert.equal(calls, 1);
});

test("allows a missing environment file", () => {
  const missing = Object.assign(new Error("missing"), { code: "ENOENT" });
  assert.doesNotThrow(() => loadEnvironmentFile(() => { throw missing; }));
});

test("propagates environment-file load errors other than a missing file", () => {
  const denied = Object.assign(new Error("denied"), { code: "EACCES" });
  assert.throws(() => loadEnvironmentFile(() => { throw denied; }), denied);
  assert.throws(() => loadEnvironmentFile(() => { throw "unexpected"; }), /unexpected/);
});
