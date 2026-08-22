import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Repository } from "./repository.js";

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
