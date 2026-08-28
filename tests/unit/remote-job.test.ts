import assert from "node:assert/strict";
import test from "node:test";
import type { AgentReport } from "../../src/agent/agent.js";
import type { CodingJob } from "../../src/application/coding-job.js";
import type { ManagedWorkspace } from "../../src/application/managed-workspace.js";
import { runRemoteJob } from "../../src/application/remote-job.js";
import type { GuillermoRunResult } from "../../src/application/run.js";
import type { GuillermoConfig } from "../../src/config/config.js";
import type { ProcessRunner } from "../../src/infrastructure/process/process-runner.js";

const config: GuillermoConfig = { apiKey: "test-key", model: "test", maxSteps: 2 };
const job: CodingJob = {
  source: { eventId: "APP-42:comment:1", metadata: {} },
  repository: { owner: "my-org", name: "app" },
  baseBranch: "main",
  branch: "guillermo/app-42",
  task: "Implement APP-42",
  prTitle: "[APP-42] Change",
};
const report: AgentReport = {
  summary: "done", termination: "finished", stepsUsed: 2, changedFiles: ["a.ts"], diff: "diff", testRuns: [], events: [],
};
const result: GuillermoRunResult = {
  report,
  originalBranch: "main",
  createdBranch: "guillermo/app-42",
  pullRequest: { status: "created", pullRequestUrl: "https://github.com/my-org/app/pull/1" },
};

function workspaceFixture(events: string[]) {
  const workspace: ManagedWorkspace = {
    root: "/tmp/canonical-checkout",
    authentication: {
      withEnvironment: async (operation) => operation({}),
      redact: (value) => value,
    },
  };
  return {
    withWorkspace: async <T>(repository: CodingJob["repository"], branch: string, operation: (value: ManagedWorkspace) => Promise<T>): Promise<T> => {
      events.push(`clone:${repository.owner}/${repository.name}:${branch}`);
      try {
        return await operation(workspace);
      } finally {
        events.push("cleanup");
      }
    },
  };
}

function sandboxFixture(events: string[]) {
  const preparationRunner: ProcessRunner = {
    run: async () => ({ exitCode: 0, stdout: "prepared", stderr: "" }),
  };
  const testRunner: ProcessRunner = {
    run: async () => ({ exitCode: 0, stdout: "tested", stderr: "" }),
  };
  return {
    preparationRunner,
    testRunner,
    provider: {
      forWorkspace: (root: string) => {
        events.push(`sandbox:${root}`);
        return { preparationRunner, testRunner };
      },
    },
  };
}

test("remote jobs prepare a fresh checkout before running the existing workflow and then clean up", async () => {
  const events: string[] = [];
  const sandbox = sandboxFixture(events);
  const receivedOptions: unknown[] = [];
  const receivedOverrides: unknown[] = [];
  const actual = await runRemoteJob(config, job, { name: "Bot", email: "bot@example.test" }, {
    createPullRequest: async () => "unused",
  }, workspaceFixture(events), sandbox.provider, {
    prepare: async (root, overrides) => {
      assert.equal(overrides?.runner, sandbox.preparationRunner);
      events.push(`prepare:${root}`);
    },
    run: async (_config, options, overrides) => {
      events.push("run");
      receivedOptions.push(options);
      receivedOverrides.push(overrides);
      return result;
    },
  });
  assert.equal(actual, result);
  assert.deepEqual(events, [
    "clone:my-org/app:main",
    "sandbox:/tmp/canonical-checkout",
    "prepare:/tmp/canonical-checkout",
    "run",
    "cleanup",
  ]);
  assert.deepEqual(receivedOptions, [{
    repo: "/tmp/canonical-checkout",
    task: "Implement APP-42",
    branch: "guillermo/app-42",
    branchStartPoint: "main",
    baseBranch: "main",
    prTitle: "[APP-42] Change",
  }]);
  assert.equal(typeof (receivedOverrides[0] as { createRepository?: unknown }).createRepository, "function");
});

test("remote jobs clean up when preparation fails", async () => {
  const events: string[] = [];
  const sandbox = sandboxFixture(events);
  await assert.rejects(runRemoteJob(config, job, { name: "Bot", email: "bot@example.test" }, {
    createPullRequest: async () => "unused",
  }, workspaceFixture(events), sandbox.provider, {
    prepare: async () => { events.push("prepare"); throw new Error("npm ci failed"); },
    run: async () => { throw new Error("must not run"); },
  }), /npm ci failed/);
  assert.deepEqual(events, ["clone:my-org/app:main", "sandbox:/tmp/canonical-checkout", "prepare", "cleanup"]);
});
