import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { HELP_TEXT, parseCli } from "../../src/entrypoints/cli/cli.js";

const cwd = "/work/guillermo";

test("parses the minimum valid command and resolves the repository path", () => {
  assert.deepEqual(parseCli(["--repo", "project", "--task", "Fix the parser"], cwd), {
    kind: "options",
    options: {
      repo: "/work/guillermo/project",
      task: "Fix the parser",
      model: undefined,
      maxSteps: undefined,
      branch: undefined,
      prTitle: undefined,
      baseBranch: undefined,
    },
  });
});

test("parses every supported option", () => {
  assert.deepEqual(parseCli([
    "--repo", "/repos/project",
    "--task", "Add coverage",
    "--branch", "guillermo/parser",
    "--base", "main",
    "--pr-title", "Add parser coverage",
    "--model", "gpt-test",
    "--max-steps", "12",
  ], cwd), {
    kind: "options",
    options: {
      repo: "/repos/project",
      task: "Add coverage",
      branch: "guillermo/parser",
      baseBranch: "main",
      prTitle: "Add parser coverage",
      model: "gpt-test",
      maxSteps: 12,
    },
  });
});

test("rejects unknown options", () => {
  assert.throws(
    () => parseCli(["--repo", "/repo", "--task", "task", "--unknown", "value"], cwd),
    /Unknown option '--unknown'/,
  );
});

test("rejects missing required options", () => {
  assert.throws(() => parseCli(["--task", "task"], cwd), /Missing required option: --repo/);
  assert.throws(() => parseCli(["--repo", "/repo"], cwd), /Missing required option: --task/);
});

test("rejects missing option values", () => {
  assert.throws(() => parseCli(["--repo", "/repo", "--task"], cwd), /Option '--task <value>' argument missing/);
});

test("rejects repeated options", () => {
  assert.throws(
    () => parseCli(["--repo", "/one", "--repo", "/two", "--task", "task"], cwd),
    /Option may only be specified once: --repo/,
  );
});

test("rejects invalid max-step values before configuration loading", () => {
  for (const value of ["many", "1.5", "Infinity"]) {
    assert.throws(
      () => parseCli(["--repo", "/repo", "--task", "task", "--max-steps", value], cwd),
      /--max-steps must be an integer/,
    );
  }
});

test("rejects unexpected positional arguments", () => {
  assert.throws(
    () => parseCli(["--repo", "/repo", "--task", "task", "extra"], cwd),
    /Unexpected argument 'extra'/,
  );
});

test("returns concise help for both help flags without requiring other options", () => {
  assert.deepEqual(parseCli(["--help"], cwd), { kind: "help", text: HELP_TEXT });
  assert.deepEqual(parseCli(["-h"], cwd), { kind: "help", text: HELP_TEXT });
  assert.match(HELP_TEXT, /Usage: npm run cli -- --repo <path> --task <description>/);
  assert.match(HELP_TEXT, /-h, --help/);
});

test("prints help and exits successfully without runtime configuration", () => {
  const entryPoint = new URL("../../src/entrypoints/cli/main.js", import.meta.url);
  const result = spawnSync(process.execPath, [entryPoint.pathname, "--help"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "" },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.trim(), HELP_TEXT);
});
