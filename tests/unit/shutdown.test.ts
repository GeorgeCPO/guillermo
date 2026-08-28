import assert from "node:assert/strict";
import test from "node:test";
import { shutdownCoordinator } from "../../src/entrypoints/http/shutdown.js";

test("graceful shutdown stops HTTP before waiting for active jobs", async () => {
  const events: string[] = [];
  const app = { close: async () => { events.push("http-closed"); } };
  const result = await shutdownCoordinator(app, async () => { events.push("jobs-drained"); }, 100);
  assert.equal(result, "drained");
  assert.deepEqual(events, ["http-closed", "jobs-drained"]);
});

test("graceful shutdown bounds its wait for in-process jobs", async () => {
  const app = { close: async () => undefined };
  const result = await shutdownCoordinator(app, () => new Promise(() => undefined), 5);
  assert.equal(result, "timed-out");
});
