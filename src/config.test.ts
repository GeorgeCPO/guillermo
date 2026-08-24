import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "./config.js";

test("configuration preserves the allowed max-step range", () => {
  const originalApiKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "test-key";
  try {
    assert.throws(() => loadConfig({ maxSteps: 0 }), /integer between 1 and 50/);
    assert.throws(() => loadConfig({ maxSteps: 51 }), /integer between 1 and 50/);
    assert.equal(loadConfig({ maxSteps: 1 }).maxSteps, 1);
    assert.equal(loadConfig({ maxSteps: 50 }).maxSteps, 50);
  } finally {
    if (originalApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalApiKey;
    }
  }
});
