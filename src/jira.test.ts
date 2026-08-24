import assert from "node:assert/strict";
import test from "node:test";
import { parseJiraWebhook, parseProjectMap } from "./jira.js";

const projects = parseProjectMap(JSON.stringify({
  APP: {
    repositoryPath: "/srv/repos/app",
    baseBranch: "main",
    prTitleFormat: "[{issueKey}] {summary}",
  },
}));

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    webhookEvent: "comment_created",
    issue: {
      key: "APP-42",
      fields: {
        project: { key: "APP" },
        summary: "Handle encoded URLs",
        description: "Preserve query strings while decoding paths.",
      },
    },
    comment: { id: "9001", body: "/guillermo" },
    ...overrides,
  };
}

test("project configuration requires trusted absolute paths, branches, and title placeholders", () => {
  assert.throws(() => parseProjectMap("not json"), /valid JSON/);
  assert.throws(() => parseProjectMap("{}"), /non-empty/);
  assert.throws(() => parseProjectMap(JSON.stringify({ APP: { repositoryPath: "relative", baseBranch: "main" } })), /absolute/);
  assert.throws(() => parseProjectMap(JSON.stringify({ APP: { repositoryPath: "/repo", baseBranch: "main branch" } })), /baseBranch/);
  assert.throws(() => parseProjectMap(JSON.stringify({ APP: { repositoryPath: "/repo", baseBranch: "main", prTitleFormat: "{unknown}" } })), /prTitleFormat/);
});

test("the exact comment command creates a bounded task from trusted issue fields", () => {
  const result = parseJiraWebhook(payload(), projects);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.deepEqual(result.job, {
    eventId: "APP-42:comment:9001",
    issueKey: "APP-42",
    projectKey: "APP",
    repositoryPath: "/srv/repos/app",
    baseBranch: "main",
    branch: "guillermo/app-42-comment-9001",
    task: "Implement the requested change for Jira issue APP-42: Handle encoded URLs\n\nIssue description:\nPreserve query strings while decoding paths.",
    prTitle: "[APP-42] Handle encoded URLs",
  });
});

test("repository, branch, and title values in the webhook payload are ignored", () => {
  const candidate = payload({ repositoryPath: "/tmp/attacker", baseBranch: "attacker", prTitleFormat: "attacker" });
  const result = parseJiraWebhook(candidate, projects);
  assert.equal(result.kind, "accepted");
  if (result.kind !== "accepted") return;
  assert.equal(result.job.repositoryPath, "/srv/repos/app");
  assert.equal(result.job.baseBranch, "main");
  assert.equal(result.job.prTitle, "[APP-42] Handle encoded URLs");
});

test("event parsing filters non-triggers and rejects malformed or non-allowlisted issues", () => {
  assert.deepEqual(parseJiraWebhook(payload({ webhookEvent: "issue_updated" }), projects), {
    kind: "ignored", reason: "event_not_comment_created",
  });
  assert.deepEqual(parseJiraWebhook({ ...payload(), comment: { id: "9001", body: "/guillermo please do more" } }, projects), {
    kind: "ignored", reason: "comment_command_not_present",
  });
  assert.deepEqual(parseJiraWebhook({ ...payload(), issue: { key: "APP-42", fields: { summary: "No project" } } }, projects), {
    kind: "invalid", reason: "invalid_trusted_issue_fields",
  });
  assert.deepEqual(parseJiraWebhook({
    ...payload(),
    issue: { key: "OPS-1", fields: { project: { key: "OPS" }, summary: "Unknown", description: null } },
  }, projects), { kind: "invalid", reason: "project_not_allowlisted" });
});

test("Jira document-format descriptions and comment commands are parsed defensively", () => {
  const candidate = payload();
  candidate.issue = {
    key: "APP-42",
    fields: {
      project: { key: "APP" },
      summary: "Document fields",
      description: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }] },
    },
  };
  candidate.comment = {
    id: 9001,
    body: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "/guillermo" }] }] },
  };
  const result = parseJiraWebhook(candidate, projects);
  assert.equal(result.kind, "accepted");
  if (result.kind === "accepted") assert.match(result.job.task, /Details/);

  candidate.comment = { id: 9001, body: { type: "doc", content: "invalid" } };
  assert.deepEqual(parseJiraWebhook(candidate, projects), { kind: "invalid", reason: "invalid_comment_body" });
});
