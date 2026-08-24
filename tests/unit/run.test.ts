import assert from "node:assert/strict";
import test from "node:test";
import type { AgentReport } from "../../src/agent/agent.js";
import {
  runGuillermo,
  type RunGuillermoDependencies,
  type RunRepository,
} from "../../src/application/run.js";
import type { GuillermoConfig } from "../../src/config/config.js";
import type { PullRequestOptions } from "../../src/integrations/github/pull-request.js";

const config: GuillermoConfig = { apiKey: "test-key", model: "test-model", maxSteps: 3 };
const finishedReport: AgentReport = {
  summary: "Implemented the task.",
  termination: "finished",
  changedFiles: ["src/example.ts"],
  diff: "example diff",
  testRuns: [{ command: "npm test", result: { exitCode: 0, output: "ok" } }],
  events: ["1. finish: ok"],
};

test("orchestrates repository preparation, agent work, and pull-request publication", async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls);
  let publication: { report: AgentReport; options: PullRequestOptions } | undefined;
  const result = await runGuillermo(config, {
    repo: "./target",
    task: "Add focused coverage",
    branchStartPoint: "origin/main",
    baseBranch: "main",
    prTitle: "Add coverage",
  }, dependencies(repository, calls, {
    runAgent: async (receivedConfig, receivedRepository, task) => {
      assert.equal(receivedConfig, config);
      assert.equal(receivedRepository, repository);
      assert.equal(task, "Add focused coverage");
      calls.push("agent");
      return finishedReport;
    },
    createPullRequest: async (report, options) => {
      publication = { report, options };
      calls.push("pull-request");
      return { status: "created", pullRequestUrl: "https://example.test/pr/1" };
    },
  }));

  assert.deepEqual(calls, [
    "access:./target",
    "realpath:./target",
    "repository:/canonical/target",
    "assert-git",
    "assert-clean",
    "current-branch",
    "checkout:guillermo/add-focused-coverage:origin/main",
    "head-commit",
    "agent",
    "pull-request",
  ]);
  assert.deepEqual(publication, {
    report: finishedReport,
    options: {
      root: "/canonical/target",
      task: "Add focused coverage",
      branch: "guillermo/add-focused-coverage",
      startingCommit: "starting-sha",
      baseBranch: "main",
      title: "Add coverage",
    },
  });
  assert.equal(result.report, finishedReport);
  assert.equal(result.originalBranch, "trunk");
  assert.equal(result.createdBranch, "guillermo/add-focused-coverage");
  assert.equal(result.pullRequest.status, "created");
});

test("turns an agent exception into a failure report and still evaluates publication", async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls, {
    changedFiles: async () => ["src/partial.ts"],
    diff: async () => "partial diff",
  });
  let receivedReport: AgentReport | undefined;
  const result = await runGuillermo(config, {
    repo: "/target",
    task: "Risky task",
    branch: "guillermo/custom",
  }, dependencies(repository, calls, {
    runAgent: async () => { throw new TypeError("model unavailable"); },
    createPullRequest: async (report) => {
      receivedReport = report;
      return { status: "skipped", reason: "The agent failed before calling finish." };
    },
  }));

  assert.deepEqual(receivedReport, {
    summary: "Agent failed: model unavailable",
    termination: "failed",
    changedFiles: ["src/partial.ts"],
    diff: "partial diff",
    testRuns: [],
    events: ["Agent: failed before finish."],
  });
  assert.equal(result.report, receivedReport);
  assert.equal(result.pullRequest.status, "skipped");
});

test("preserves the agent failure when collecting the partial diff also fails", async () => {
  const calls: string[] = [];
  const repository = fakeRepository(calls, {
    changedFiles: async () => { throw new Error("git unavailable"); },
  });
  let receivedReport: AgentReport | undefined;
  await runGuillermo(config, { repo: "/target", task: "Task" }, dependencies(repository, calls, {
    runAgent: async () => { throw "agent stopped"; },
    createPullRequest: async (report) => {
      receivedReport = report;
      return { status: "skipped" };
    },
  }));

  assert.equal(receivedReport?.summary, "Agent failed: agent stopped");
  assert.deepEqual(receivedReport?.changedFiles, []);
  assert.equal(receivedReport?.diff, "Could not read the working-tree diff after the agent failed.");
});

function dependencies(
  repository: RunRepository,
  calls: string[],
  overrides: Pick<RunGuillermoDependencies, "runAgent" | "createPullRequest">,
): Partial<RunGuillermoDependencies> {
  return {
    access: async (path) => { calls.push(`access:${path}`); },
    realpath: async (path) => { calls.push(`realpath:${path}`); return "/canonical/target"; },
    createRepository: (root) => { calls.push(`repository:${root}`); return repository; },
    ...overrides,
  };
}

function fakeRepository(calls: string[], overrides: Partial<RunRepository> = {}): RunRepository {
  return {
    assertGitRepository: async () => { calls.push("assert-git"); },
    assertCleanWorkingTree: async () => { calls.push("assert-clean"); },
    currentBranch: async () => { calls.push("current-branch"); return "trunk"; },
    createAndCheckoutBranch: async (branch, startPoint) => { calls.push(`checkout:${branch}:${startPoint ?? ""}`); },
    headCommit: async () => { calls.push("head-commit"); return "starting-sha"; },
    changedFiles: async () => [],
    diff: async () => "No uncommitted changes.",
    ...overrides,
  };
}
