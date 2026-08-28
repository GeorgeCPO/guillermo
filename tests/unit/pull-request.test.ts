import assert from "node:assert/strict";
import test from "node:test";
import type { AgentReport } from "../../src/agent/agent.js";
import {
  createPullRequest,
  createRemotePullRequest,
  deriveCommitMessage,
  derivePullRequestTitle,
  evaluatePullRequestEligibility,
  parseChangedPaths,
} from "../../src/integrations/github/pull-request.js";
import type { ProcessRunner } from "../../src/infrastructure/process/process-runner.js";
import { ProcessGitClient } from "../../src/infrastructure/git/git-client.js";

function report(overrides: Partial<AgentReport> = {}): AgentReport {
  return {
    summary: "Done.",
    termination: "finished",
    stepsUsed: 3,
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
    reasonCode: "agent_step_limit",
    reason: "The agent reached its step limit without calling finish.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ termination: "failed" })), {
    eligible: false,
    reasonCode: "agent_failed",
    reason: "The agent failed before calling finish.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ termination: "stopped" })), {
    eligible: false,
    reasonCode: "agent_stopped",
    reason: "The agent stopped without calling finish.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ changedFiles: [] })), {
    eligible: false,
    reasonCode: "no_files_changed",
    reason: "The agent finished without changing any files.",
  });
  assert.deepEqual(evaluatePullRequestEligibility(report({ testRuns: [{ command: "npm test", result: { exitCode: 1, output: "failed" } }] })), {
    eligible: false,
    reasonCode: "no_successful_test_run",
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
    const runner: ProcessRunner = { run: async ({ executable, args }) => {
      calls.push(`${executable} ${args.join(" ")}`);
      return { exitCode: 0, stdout: "", stderr: "" };
    } };
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
  const runner: ProcessRunner = { run: async ({ executable: program, args, cwd }) => {
    calls.push({ program, args: [...args], cwd });
    if (program === "git" && args[0] === "ls-remote") {
      return { exitCode: 2, stdout: "", stderr: "branch absent" };
    }
    if (program === "git" && args[0] === "branch") return { exitCode: 0, stdout: "guillermo/add-parser-tests\n", stderr: "" };
    if (program === "git" && args[0] === "status") return { exitCode: 0, stdout: " M src/example.ts\0?? test/example.test.ts\0", stderr: "" };
    if (program === "git" && args[0] === "rev-parse") {
      revParseCalls += 1;
      return { exitCode: 0, stdout: revParseCalls === 1 ? "base123\n" : "abc123\n", stderr: "" };
    }
    if (program === "gh" && args[0] === "pr") return { exitCode: 0, stdout: "https://github.com/acme/project/pull/42\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };

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
  const runner: ProcessRunner = { run: async ({ executable, args }) => {
    calls.push(`${executable} ${args.join(" ")}`);
    return { exitCode: 0, stdout: "refs/heads/guillermo/add-tests\n", stderr: "" };
  } };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "Add tests",
    branch: "guillermo/add-tests",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "skipped");
  assert.equal(result.reasonCode, "remote_branch_exists");
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
  const runner: ProcessRunner = { run: async ({ executable: program, args }) => {
    calls.push(`${program} ${args.join(" ")}`);
    if (program === "git" && args[0] === "ls-remote") {
      return { exitCode: 2, stdout: "", stderr: "branch absent" };
    }
    if (program === "git" && args[0] === "branch") return { exitCode: 0, stdout: "guillermo/add-tests\n", stderr: "" };
    if (program === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: "different-commit\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "Add tests",
    branch: "guillermo/add-tests",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "skipped");
  assert.equal(result.reasonCode, "head_changed");
  assert.match(result.reason ?? "", /HEAD changed/);
  assert.equal(calls.some((call) => call.startsWith("git add") || call.startsWith("git commit") || call.startsWith("git push")), false);
});

test("a changed working branch is classified and refused before reading or staging changes", async () => {
  const calls: string[] = [];
  const runner: ProcessRunner = { run: async ({ executable, args }) => {
    calls.push(`${executable} ${args.join(" ")}`);
    if (executable === "git" && args[0] === "ls-remote") return { exitCode: 2, stdout: "", stderr: "absent" };
    if (executable === "git" && args[0] === "branch") return { exitCode: 0, stdout: "task-derived-private-branch\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "private task text",
    branch: "guillermo/expected",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "skipped");
  assert.equal(result.reasonCode, "working_branch_changed");
  assert.equal(calls.some((call) => call.startsWith("git status") || call.startsWith("git add")), false);
});

test("an empty porcelain status is classified as no remaining uncommitted files", async () => {
  const runner: ProcessRunner = { run: async ({ executable, args }) => {
    if (executable === "git" && args[0] === "ls-remote") return { exitCode: 2, stdout: "", stderr: "absent" };
    if (executable === "git" && args[0] === "branch") return { exitCode: 0, stdout: "guillermo/expected\n", stderr: "" };
    if (executable === "git" && args[0] === "rev-parse") return { exitCode: 0, stdout: "base123\n", stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "private task text",
    branch: "guillermo/expected",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "skipped");
  assert.equal(result.reasonCode, "no_uncommitted_files");
});

test("unclassified publication errors receive the safe general publication code", async () => {
  const runner: ProcessRunner = {
    run: async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "RAW_PRIVATE_ERROR token-private /private/repository/file.ts",
    }),
  };

  const result = await createPullRequest(report(), {
    root: "/repo",
    task: "private task text",
    branch: "guillermo/private-task",
    startingCommit: "base123",
    baseBranch: "main",
  }, runner);

  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "publication_failed");
});

test("status parsing retains both sides of a rename for precise staging", () => {
  assert.deepEqual(parseChangedPaths("R  src/new.ts\0src/old.ts\0"), ["src/new.ts", "src/old.ts"]);
  assert.equal(deriveCommitMessage("A task"), "Guillermo: A task");
  assert.equal(derivePullRequestTitle("A task"), "Guillermo: A task");
});

test("remote publishing uses credential-scoped Git and the REST API without gh or token arguments", async () => {
  const calls: Array<{ executable: string; args: readonly string[]; env?: Readonly<Record<string, string>> }> = [];
  let heads = 0;
  const runner: ProcessRunner = { run: async (request) => {
    calls.push({ executable: request.executable, args: request.args, env: request.env });
    if (request.args[0] === "remote") return { exitCode: 0, stdout: "https://github.com/my-org/app.git\n", stderr: "" };
    if (request.args[0] === "ls-remote") return { exitCode: 2, stdout: "", stderr: "absent" };
    if (request.args[0] === "branch") return { exitCode: 0, stdout: "guillermo/app-42\n", stderr: "" };
    if (request.args[0] === "status") return { exitCode: 0, stdout: " M src/app.ts\0", stderr: "" };
    if (request.args[0] === "rev-parse") return { exitCode: 0, stdout: `${++heads === 1 ? "base123" : "commit456"}\n`, stderr: "" };
    return { exitCode: 0, stdout: "", stderr: "" };
  } };
  const apiCalls: unknown[] = [];
  const authentication = {
    withEnvironment: async <T>(operation: (environment: Readonly<Record<string, string>>) => Promise<T>) => operation({ PATH: "/bin", GIT_ASKPASS: "/tmp/askpass", GUILLERMO_GIT_PASSWORD: "installation-token" }),
    redact: (value: string) => value.replaceAll("installation-token", "[REDACTED]"),
  };
  const result = await createRemotePullRequest(report(), {
    root: "/repo",
    task: "Fix APP-42",
    branch: "guillermo/app-42",
    startingCommit: "base123",
    baseBranch: "main",
    repository: { owner: "my-org", name: "app" },
    commitAuthor: { name: "Guillermo Bot", email: "bot@example.test" },
  }, authentication, {
    createPullRequest: async (input) => { apiCalls.push(input); return "https://github.com/my-org/app/pull/42"; },
  }, new ProcessGitClient(runner));

  assert.deepEqual(result, {
    status: "created", commitSha: "commit456", pushedBranch: "guillermo/app-42", pullRequestUrl: "https://github.com/my-org/app/pull/42",
  });
  assert.equal(calls.some(({ executable }) => executable === "gh"), false);
  assert.doesNotMatch(JSON.stringify(calls.map(({ args }) => args)), /installation-token|x-access-token/);
  const authenticated = calls.filter(({ env }) => env?.GUILLERMO_GIT_PASSWORD);
  assert.deepEqual(authenticated.map(({ args }) => args[0]), ["ls-remote", "push"]);
  const commit = calls.find(({ args }) => args[0] === "commit");
  assert.equal(commit?.env?.GIT_AUTHOR_NAME, "Guillermo Bot");
  assert.equal(commit?.env?.GUILLERMO_GIT_PASSWORD, undefined);
  assert.deepEqual(apiCalls, [{
    repository: { owner: "my-org", name: "app" },
    title: "Guillermo: Fix APP-42",
    body: "Created by Guillermo for: Fix APP-42",
    head: "guillermo/app-42",
    base: "main",
  }]);
});

test("remote publishing refuses a changed origin before acquiring credentials", async () => {
  let credentialCalls = 0;
  const runner: ProcessRunner = { run: async () => ({ exitCode: 0, stdout: "https://evil.test/repo.git\n", stderr: "" }) };
  const result = await createRemotePullRequest(report(), {
    root: "/repo", task: "task", branch: "guillermo/task", startingCommit: "base", baseBranch: "main",
    repository: { owner: "my-org", name: "app" }, commitAuthor: { name: "Bot", email: "bot@example.test" },
  }, {
    withEnvironment: async <T>(operation: (environment: Readonly<Record<string, string>>) => Promise<T>) => { credentialCalls += 1; return operation({}); },
    redact: (value) => value,
  }, { createPullRequest: async () => "unused" }, new ProcessGitClient(runner));
  assert.equal(result.status, "skipped");
  assert.equal(result.reasonCode, "git_origin_changed");
  assert.match(result.reason ?? "", /origin changed/);
  assert.equal(credentialCalls, 0);
});
