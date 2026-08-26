import assert from "node:assert/strict";
import test from "node:test";
import { ProcessGitClient } from "../../src/infrastructure/git/git-client.js";
import type { ProcessRequest, ProcessResult, ProcessRunner } from "../../src/infrastructure/process/process-runner.js";

class FakeRunner implements ProcessRunner {
  readonly calls: ProcessRequest[] = [];
  readonly results: ProcessResult[] = [];

  async run(request: ProcessRequest): Promise<ProcessResult> {
    this.calls.push(request);
    return this.results.shift() ?? { exitCode: 0, stdout: "", stderr: "" };
  }
}

test("ProcessGitClient constructs explicit Git argument arrays and forwards patch stdin", async () => {
  const runner = new FakeRunner();
  const git = new ProcessGitClient(runner);

  await git.createAndSwitchBranch("/repo", "guillermo/topic", "main");
  await git.checkPatch("/repo", "diff contents");
  await git.addPaths("/repo", ["a file.ts", "semi;colon.ts"]);
  await git.pushBranch("/repo", "guillermo/topic");

  assert.deepEqual(runner.calls, [
    { executable: "git", args: ["switch", "--create", "guillermo/topic", "main"], cwd: "/repo" },
    { executable: "git", args: ["apply", "--check", "--whitespace=error-all", "-"], cwd: "/repo", input: "diff contents" },
    { executable: "git", args: ["add", "--all", "--", "a file.ts", "semi;colon.ts"], cwd: "/repo" },
    { executable: "git", args: ["push", "--set-upstream", "origin", "guillermo/topic"], cwd: "/repo", timeoutMs: 300_000, maxOutputBytes: 100_000 },
  ]);
});

test("ProcessGitClient gives git ls-remote exit 2 domain meaning", async () => {
  const runner = new FakeRunner();
  runner.results.push({ exitCode: 2, stdout: "", stderr: "not found" });
  const git = new ProcessGitClient(runner);

  assert.equal(await git.remoteBranchExists("/repo", "guillermo/topic"), false);
  assert.deepEqual(runner.calls[0], {
    executable: "git",
    args: ["ls-remote", "--exit-code", "--heads", "origin", "refs/heads/guillermo/topic"],
    cwd: "/repo",
    timeoutMs: 300_000,
    maxOutputBytes: 100_000,
  });
});

test("ProcessGitClient does not treat unexpected git ls-remote failures as absence", async () => {
  const runner = new FakeRunner();
  runner.results.push({ exitCode: 128, stdout: "", stderr: "network failure" });

  await assert.rejects(
    new ProcessGitClient(runner).remoteBranchExists("/repo", "guillermo/topic"),
    /network failure/,
  );
});
