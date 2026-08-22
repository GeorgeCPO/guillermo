import assert from "node:assert/strict";
import test from "node:test";
import type { AgentReport } from "./agent.js";
import {
  createPullRequest,
  deriveCommitMessage,
  derivePullRequestTitle,
  evaluatePullRequestEligibility,
  parseChangedPaths,
  type ProcessRunner,
} from "./pull-request.js";

function report(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    summary: "Done.",
    termination: "finished",
    changedFiles: [" M src/example.ts"],
    diff: "diff",
    testRuns: [{ command: "npm test", result: { exitCode: 0, output: "ok" } }],
    events: [],
    ...overrides,
  };
}

test("pull-request eligibility requires finish, changes, and a passing run_tests result", () => {
  assert.deepEqual(evaluatePullRequestEligibility(report({ termination: "step_limit" })), {
    eligible: false,
    reason: "The agent reached its step limit without calling finish.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ termination: "failed" })), {
    eligible: false,
    reason: "The agent failed before calling finish.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ changedFiles: [] })), {
    eligible: false,
    reason: "The agent finished without changing any files.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ testRuns: [{ command: "npm test", result: { exitCode: 1, output: "failed" } }] })), {
    eligible: false,
    reason: "No run_tests invocation completed successfully.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report()), { eligible: true });
});

test("ineligible reports do not execute Git or GitHub commands", async () => {
  for (const ineligibleReport of [
    report({ termination: "failed" }),
    report({ termination: "step_limit" }),
    report({ changedFiles: [] }),
    report({ testRuns: [] }),
  ]) {
    const calls: string[] = [];
    const runner: ProcessRunner = async (program, args) => {
      calls.push(`${program} ${args.join(" ")}`);
      return { stdout: "", stderr: "" };
    };
    const result = await createPullRequest(ineligibleReport, {
      root: "/repo",
      task: "Add tests",
      branch: "guillermo/add-tests",
      startingCommit: "base123",
      baseBranch: "main",
    }, runner);

    assert.equal(result.status, "skipped");
    assert.deepEqual(calls, []);
  }
});

test("pull-request publishing constructs safe Git and gh argument arrays", async () => {
  const calls: Array<{ program: string; args: string[]; cwd: string }> = [];
  let revParseCalls = 0;
  const runner: ProcessRunner = async (program, args, cwd) => {
    calls.push({ program, args, cwd });
    if (program === "git" && args[0] === "ls-remote") {
      throw Object.assign(new Error("branch absent"), { code: 2 });
    }
    if (program === "git" && args[0] === "branch") return { stdout: "guillermo/add-parser-tests\n", stderr: "" };
    if (program === "git" && args[0] === "status") return { stdout: " M src/example.ts\0?? test/example.test.ts\0", stderr: "" };
    if (program === "git" && args[0] === "rev-parse") {
      revParseCalls += 1;
      return { stdout: revParseCalls === 1 ? "base123\n" : "abc123\n", stderr: "" };
    }
    if (program === "gh" && args[0] === "pr") return { stdout: "https://github.com/acme/project/pull/42\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "Add parser tests\nand fix parsing",
    branch: "guillermo/add-parser-tests",
    startingCommit: "base123",
    baseBranch: "main",
    title: "Parser coverage",
  }, runner);

  assert.deepEqual(result, {
    status: "created",
    commitSha: "abc123",
    pushedBranch: "guillermo/add-parser-tests",
    pullRequestUrl: "https://github.com/acme/project/pull/42",
  });
  assert.deepEqual(calls, [
    { program: "git", args: ["remote", "get-url", "origin"], cwd: "/repo" },
    { program: "git", args: ["check-ref-format", "--branch", "main"], cwd: "/repo" },
    { program: "gh", args: ["auth", "status"], cwd: "/repo" },
    { program: "git", args: ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/guillermo/add-parser-tests"], cwd: "/repo" },
    { program: "git", args: ["branch", "--show-current"], cwd: "/repo" },
    { program: "git", args: ["rev-parse", "HEAD"], cwd: "/repo" },
    { program: "git", args: ["status", "--porcelain=v1", "-z"], cwd: "/repo" },
    { program: "git", args: ["add", "--all", "--", "src/example.ts", "test/example.test.ts"], cwd: "/repo" },
    { program: "git", args: ["commit", "-m", "Guillermo: Add parser tests and fix parsing"], cwd: "/repo" },
    { program: "git", args: ["rev-parse", "HEAD"], cwd: "/repo" },
    { program: "git", args: ["push", "--set-upstream", "origin", "guillermo/add-parser-tests"], cwd: "/repo" },
    {
      program: "gh",
      args: [
        "pr", "create", "--base", "main", "--head", "guillermo/add-parser-tests", "--title", "Parser coverage",
        "--body", "Created by Guillermo for: Add parser tests and fix parsing",
      ],
      cwd: "/repo",
    },
  ]);
});

test("an existing remote branch is refused before staging, committing, or pushing", async () => {
  const calls: string[] = [];
  const runner: ProcessRunner = async (program, args) => {
    calls.push(`${program} ${args.join(" ")}`);
    return { stdout: "refs/heads/guillermo/add-tests\n", stderr: "" };
  };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "Add tests",
    branch: "guillermo/add-tests",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "skipped");
  assert.match(result.reason ?? "", /already exists/);
  assert.deepEqual(calls, [
    "git remote get-url origin",
    "git check-ref-format --branch main",
    "gh auth status",
    "git ls-remote --exit-code --heads origin refs/heads/guillermo/add-tests",
  ]);
});

test("a prior commit during the agent run is refused to preserve a single Guillermo commit", async () => {
  const calls: string[] = [];
  const runner: ProcessRunner = async (program, args) => {
    calls.push(`${program} ${args.join(" ")}`);
    if (program === "git" && args[0] === "ls-remote") {
      throw Object.assign(new Error("branch absent"), { code: 2 });
    }
    if (program === "git" && args[0] === "branch") return { stdout: "guillermo/add-tests\n", stderr: "" };
    if (program === "git" && args[0] === "rev-parse") return { stdout: "different-commit\n", stderr: "" };
    return { stdout: "", stderr: "" };
  };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "Add tests",
    branch: "guillermo/add-tests",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "skipped");
  assert.match(result.reason ?? "", /HEAD changed/);
  assert.equal(calls.some((call) => call.startsWith("git add") || call.startsWith("git commit") || call.startsWith("git push")), false);
});

test("status parsing retains both sides of a rename for precise staging", () => {
  assert.deepEqual(parseChangedPaths("R  src/new.ts\0src/old.ts\0"), ["src/new.ts", "src/old.ts"]);
  assert.equal(deriveCommitMessage("A task"), "Guillermo: A task");
  assert.equal(derivePullRequestTitle("A task"), "Guillermo: A task");
});
