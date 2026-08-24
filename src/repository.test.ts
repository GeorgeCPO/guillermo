import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { Repository } from "./repository.js";

const execFileAsync = promisify(execFile);

async function createRepository(t: { after(callback: () => Promise<void>): void }): Promise<{ root: string; repository: Repository }> {
  const root = await mkdtemp(path.join(tmpdir(), "guillermo-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, repository: new Repository(root) };
}

async function writeFixture(root: string, relativePath: string, contents: string | Buffer): Promise<void> {
  const filePath = path.join(root, relativePath);
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, contents);
}

async function runGit(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd: root });
  return stdout;
}

async function createGitRepository(t: { after(callback: () => Promise<void>): void }): Promise<{ root: string; repository: Repository }> {
  const root = await mkdtemp(path.join(tmpdir(), "guillermo-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ["init"]);
  await runGit(root, ["config", "user.email", "guillermo@example.test"]);
  await runGit(root, ["config", "user.name", "Guillermo test"]);
  await writeFixture(root, "README.md", "initial\n");
  await runGit(root, ["add", "README.md"]);
  await runGit(root, ["commit", "-m", "Initial commit"]);
  return { root, repository: new Repository(root) };
}

test("search_repository returns deterministic repository-relative matching lines", async (t) => {
  const { root, repository } = await createRepository(t);
  await writeFixture(root, "z.txt", "needle at one\nneedle at two\n");
  await writeFixture(root, "a.txt", "first\nneedle at two\nlast\n");

  assert.deepEqual(await repository.searchText("needle", ".", 10), [
    { path: "a.txt", line: 2, text: "needle at two" },
    { path: "z.txt", line: 1, text: "needle at one" },
    { path: "z.txt", line: 2, text: "needle at two" },
  ]);
});

test("search_repository keeps paths within the repository and blocks sensitive paths", async (t) => {
  const { root, repository } = await createRepository(t);
  const outside = await mkdtemp(path.join(tmpdir(), "guillermo-search-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await writeFixture(outside, "outside.txt", "needle\n");
  await symlink(outside, path.join(root, "outside"));

  await assert.rejects(repository.searchText("needle", "../outside", 10), /leave the repository root/);
  await assert.rejects(repository.searchText("needle", "outside", 10), /outside the repository root/);
  await assert.rejects(repository.searchText("needle", ".git", 10), /blocked/);
  await assert.rejects(repository.searchText("needle", "node_modules", 10), /blocked/);
  await assert.rejects(repository.searchText("needle", "package-lock.json", 10), /blocked/);
  await mkdir(path.join(root, "dist"));
  await assert.rejects(repository.searchText("needle", "dist", 10), /ignored/);
});

test("search_repository validates its query and result limit", async (t) => {
  const { repository } = await createRepository(t);
  await assert.rejects(repository.searchText("", ".", 10), /non-empty/);
  await assert.rejects(repository.searchText("needle", ".", 0), /between 1 and 100/);
  await assert.rejects(repository.searchText("needle", ".", 101), /between 1 and 100/);
  await assert.rejects(repository.searchText("needle", ".", 1.5), /integer/);
});

test("search_repository limits matches and skips ignored, binary, and oversized files", async (t) => {
  const { root, repository } = await createRepository(t);
  await writeFixture(root, "a.txt", "needle one\nneedle two\n");
  await writeFixture(root, "dist/ignored.txt", "needle ignored\n");
  await writeFixture(root, "coverage/ignored.txt", "needle ignored\n");
  await writeFixture(root, ".env", "needle secret\n");
  await writeFixture(root, "package-lock.json", "needle lockfile\n");
  await writeFixture(root, "binary.bin", Buffer.from([0, 110, 101, 101, 100, 108, 101]));
  await writeFixture(root, "large.txt", `${"x".repeat(100_000)}needle`);

  assert.deepEqual(await repository.searchText("needle", ".", 1), [
    { path: "a.txt", line: 1, text: "needle one" },
  ]);
  assert.deepEqual(await repository.searchText("needle", ".", 10), [
    { path: "a.txt", line: 1, text: "needle one" },
    { path: "a.txt", line: 2, text: "needle two" },
  ]);
});

test("a clean repository gets a new checked-out working branch", async (t) => {
  const { root, repository } = await createGitRepository(t);
  const originalBranch = await repository.currentBranch();
  const originalCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();

  await repository.assertCleanWorkingTree();
  await repository.createAndCheckoutBranch("guillermo/add-parser-tests");

  assert.equal(await repository.currentBranch(), "guillermo/add-parser-tests");
  assert.notEqual(await repository.currentBranch(), originalBranch);
  assert.equal((await runGit(root, ["rev-parse", "HEAD"])).trim(), originalCommit);
});

test("an explicit start point prevents a new run from inheriting the previous working branch", async (t) => {
  const { root, repository } = await createGitRepository(t);
  const baseBranch = await repository.currentBranch();
  const baseCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();
  await repository.createAndCheckoutBranch("guillermo/first-run");
  await writeFixture(root, "first-run.txt", "first run\n");
  await runGit(root, ["add", "first-run.txt"]);
  await runGit(root, ["commit", "-m", "First run"]);
  const firstRunCommit = (await runGit(root, ["rev-parse", "HEAD"])).trim();

  await repository.createAndCheckoutBranch("guillermo/second-run", baseBranch);

  assert.equal(await repository.currentBranch(), "guillermo/second-run");
  assert.equal((await runGit(root, ["rev-parse", "HEAD"])).trim(), baseCommit);
  assert.notEqual((await runGit(root, ["rev-parse", "HEAD"])).trim(), firstRunCommit);
});

test("an explicit start point must be an existing local branch", async (t) => {
  const { repository } = await createGitRepository(t);

  await assert.rejects(
    repository.createAndCheckoutBranch("guillermo/new-run", "missing-base"),
    /does not exist locally/,
  );
});

test("a dirty repository is rejected before a working branch is created", async (t) => {
  const { root, repository } = await createGitRepository(t);
  const originalBranch = await repository.currentBranch();
  await writeFixture(root, "untracked.txt", "dirty\n");

  await assert.rejects(repository.assertCleanWorkingTree(), /dirty working tree/);
  assert.equal(await repository.currentBranch(), originalBranch);
  assert.equal((await runGit(root, ["branch", "--list", "guillermo/after-dirty-check"])).trim(), "");
});

test("an existing branch is refused without changing the current branch", async (t) => {
  const { root, repository } = await createGitRepository(t);
  const originalBranch = await repository.currentBranch();
  await runGit(root, ["branch", "guillermo/existing"]);

  await assert.rejects(repository.createAndCheckoutBranch("guillermo/existing"), /already exists/);
  assert.equal(await repository.currentBranch(), originalBranch);
});

test("invalid branch names are rejected before Git can create a branch", async (t) => {
  const { repository } = await createGitRepository(t);

  await assert.rejects(repository.createAndCheckoutBranch("guillermo/has space"), /Invalid Git branch name/);
});
