import assert from "node:assert/strict";
import test from "node:test";
import { summarizeJobExecution } from "../../src/application/job-observability.js";
import type { GuillermoRunResult } from "../../src/application/run.js";
import type { PullRequestResult } from "../../src/integrations/github/pull-request.js";

test("summarizes a created pull request with agent and test counts", () => {
  assert.deepEqual(summarizeJobExecution(runResult({ status: "created" })), {
    outcome: "created",
    agentTermination: "finished",
    agentStepCount: 7,
    changedFileCount: 2,
    testRunCount: 3,
    successfulTestRunCount: 2,
  });
});

test("forwards typed skip and publication-failure codes without forwarding detailed strings", () => {
  const results: PullRequestResult[] = [
    {
      status: "skipped",
      reasonCode: "agent_step_limit",
      reason: "TASK_TEXT_PRIVATE step details",
    },
    {
      status: "skipped",
      reasonCode: "no_files_changed",
      reason: "ISSUE_DESCRIPTION_PRIVATE",
    },
    {
      status: "skipped",
      reasonCode: "no_successful_test_run",
      reason: "COMMAND_OUTPUT_PRIVATE",
    },
    {
      status: "failed",
      reasonCode: "publication_failed",
      reason: "RAW_ERROR_PRIVATE /secret/path.ts token-private",
      pullRequestUrl: "https://github.example/private-owner/private-repo/pull/1",
      pushedBranch: "guillermo/task-derived-private-branch",
    },
  ];

  const summaries = results.map((pullRequest) => summarizeJobExecution(runResult(pullRequest)));
  assert.deepEqual(summaries.map(({ outcome }) => outcome), ["skipped", "skipped", "skipped", "failed"]);
  assert.deepEqual(summaries.map((summary) => "reasonCode" in summary ? summary.reasonCode : undefined), [
    "agent_step_limit",
    "no_files_changed",
    "no_successful_test_run",
    "publication_failed",
  ]);

  const serialized = JSON.stringify(summaries);
  for (const forbidden of [
    "TASK_TEXT_PRIVATE",
    "ISSUE_DESCRIPTION_PRIVATE",
    "COMMAND_OUTPUT_PRIVATE",
    "RAW_ERROR_PRIVATE",
    "/secret/path.ts",
    "token-private",
    "private-owner",
    "private-repo",
    "task-derived-private-branch",
    "PRIVATE_DIFF",
    "PRIVATE_TEST_COMMAND",
    "PRIVATE_TEST_OUTPUT",
  ]) assert.doesNotMatch(serialized, new RegExp(forbidden));
});

function runResult(pullRequest: PullRequestResult): GuillermoRunResult {
  return {
    report: {
      summary: "TASK_TEXT_PRIVATE and ISSUE_DESCRIPTION_PRIVATE",
      termination: pullRequest.status === "skipped" && pullRequest.reasonCode === "agent_step_limit"
        ? "step_limit"
        : "finished",
      stepsUsed: 7,
      changedFiles: ["/private/repository/src/private.ts", "secret-filename.txt"],
      diff: "PRIVATE_DIFF",
      testRuns: [
        { command: "PRIVATE_TEST_COMMAND", result: { exitCode: 0, output: "PRIVATE_TEST_OUTPUT" } },
        { command: "another secret command", result: { exitCode: 1, output: "token-private" } },
        { command: "third command", result: { exitCode: 0, output: "installation-token-private" } },
      ],
      events: ["PRIVATE_AGENT_RESPONSE"],
    },
    originalBranch: "private-original-branch",
    createdBranch: "guillermo/task-derived-private-branch",
    pullRequest,
  };
}
