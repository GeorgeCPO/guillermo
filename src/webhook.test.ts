import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { JiraJob } from "./jira.js";
import { createWebhookApp, InProcessJobQueue, type JobQueue, type LogRecord } from "./webhook.js";

const secret = "correct-horse-battery-staple";
const projects = { APP: { repositoryPath: "/srv/repos/app", baseBranch: "main" } } as const;

function webhookPayload(): Record<string, unknown> {
  return {
    webhookEvent: "comment_created",
    issue: {
      key: "APP-42",
      fields: { project: { key: "APP" }, summary: "Add coverage", description: "Cover edge cases." },
    },
    comment: { id: "9001", body: "/guillermo" },
  };
}

test("missing or invalid authentication is rejected before parsing or dispatch", async (t) => {
  let enqueueCalls = 0;
  const queue: JobQueue = { enqueue: () => { enqueueCalls += 1; return true; } };
  const { app } = webhookApp(t, queue);

  const missing = await post(app, webhookPayload());
  const invalid = await post(app, webhookPayload(), "wrong-secret-value");
  const malformedButUnauthenticated = await postRaw(app, "not-json");

  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
  assert.equal(malformedButUnauthenticated.statusCode, 401);
  assert.equal(enqueueCalls, 0);
  assert.doesNotMatch(missing.body, /secret|correct-horse/i);
});

test("unsupported content types are rejected", async (t) => {
  const { app } = webhookApp(t, { enqueue: () => true });
  const response = await app.inject({
    method: "POST",
    url: "/webhooks/jira",
    headers: { "content-type": "text/plain", "x-guillermo-webhook-secret": secret },
    payload: JSON.stringify(webhookPayload()),
  });

  assert.equal(response.statusCode, 415);
  assert.deepEqual(response.json(), { status: "rejected" });
});

test("malformed and invalid payloads are rejected", async (t) => {
  let enqueueCalls = 0;
  const { app } = webhookApp(t, { enqueue: () => { enqueueCalls += 1; return true; } });

  const malformed = await postRaw(app, "not-json", secret);
  const invalid = await post(app, { webhookEvent: "comment_created" }, secret);
  const empty = await postRaw(app, "", secret);

  assert.equal(malformed.statusCode, 400);
  assert.equal(invalid.statusCode, 400);
  assert.equal(empty.statusCode, 400);
  assert.deepEqual(malformed.json(), { status: "rejected" });
  assert.equal(enqueueCalls, 0);
});

test("request bodies are limited to 256,000 bytes", async (t) => {
  const { app } = webhookApp(t, { enqueue: () => true });
  const response = await postRaw(app, JSON.stringify({ padding: "x".repeat(256_000) }), secret);

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), { status: "rejected" });
});

test("non-trigger events are filtered without dispatching work", async (t) => {
  let enqueueCalls = 0;
  const queue: JobQueue = { enqueue: () => { enqueueCalls += 1; return true; } };
  const { app, logs } = webhookApp(t, queue);
  const candidate = webhookPayload();
  candidate.webhookEvent = "issue_updated";

  const response = await post(app, candidate, secret);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ignored" });
  assert.equal(enqueueCalls, 0);
  assert.equal(logs.at(-1)?.event, "rejected");
});

test("accepted requests return 202 through an asynchronous dispatcher", async (t) => {
  let resolveRun!: () => void;
  const blocker = new Promise<void>((resolve) => { resolveRun = resolve; });
  let started = false;
  const logs: LogRecord[] = [];
  const queue = new InProcessJobQueue(async () => {
    started = true;
    await blocker;
    return { outcome: "created" };
  }, (record) => logs.push(record));
  const { app } = webhookApp(t, queue, logs);

  const response = await post(app, webhookPayload(), secret);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: "accepted" });
  assert.equal(started, true);
  assert.equal(logs.some(({ event }) => event === "completed"), false);
  assert.doesNotMatch(JSON.stringify(logs), /correct-horse|Cover edge cases/);

  resolveRun();
  await eventually(() => logs.some(({ event }) => event === "completed"));
  assert.equal(logs.find(({ event }) => event === "completed")?.outcome, "created");
});

test("Fastify logs webhook metadata without secrets or issue descriptions", async (t) => {
  let output = "";
  const app = createWebhookApp({
    secret,
    projects,
    queue: { enqueue: () => true },
    fastifyLogger: { stream: { write: (chunk: string) => { output += chunk; } } },
  });
  t.after(() => app.close());

  const response = await post(app, webhookPayload(), secret);

  assert.equal(response.statusCode, 202);
  assert.match(output, /"event":"accepted"/);
  assert.doesNotMatch(output, /correct-horse|Cover edge cases/);
});

test("duplicate deliveries do not start the same active event twice", async (t) => {
  let resolveRun!: () => void;
  const blocker = new Promise<void>((resolve) => { resolveRun = resolve; });
  let runs = 0;
  const logs: LogRecord[] = [];
  const queue = new InProcessJobQueue(async () => { runs += 1; await blocker; }, (record) => logs.push(record));
  const { app } = webhookApp(t, queue, logs);

  const first = await post(app, webhookPayload(), secret);
  const duplicate = await post(app, webhookPayload(), secret);
  assert.equal(first.statusCode, 202);
  assert.equal(duplicate.statusCode, 202);
  assert.deepEqual(duplicate.json(), { status: "duplicate" });
  assert.equal(runs, 1);
  assert.equal(logs.filter(({ event }) => event === "duplicate").length, 1);
  resolveRun();
});

test("unknown routes return 404 and unsupported Jira methods return 405", async (t) => {
  const { app } = webhookApp(t, { enqueue: () => true });

  const unknown = await app.inject({ method: "POST", url: "/unknown" });
  const unsupportedMethod = await app.inject({ method: "GET", url: "/webhooks/jira" });

  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { status: "not_found" });
  assert.equal(unsupportedMethod.statusCode, 405);
  assert.deepEqual(unsupportedMethod.json(), { status: "rejected" });
});

test("webhook secrets must contain at least 16 bytes", () => {
  assert.throws(
    () => createWebhookApp({ secret: "too-short", projects, queue: { enqueue: () => true }, fastifyLogger: false }),
    /at least 16 bytes/,
  );
});

test("the in-process queue serializes separate jobs for the same repository", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const starts: string[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.eventId);
    if (candidate.eventId === "first") await firstBlocked;
  }, () => undefined);

  assert.equal(queue.enqueue(job("first")), true);
  assert.equal(queue.enqueue(job("second")), true);
  await eventually(() => starts.length === 1);
  assert.deepEqual(starts, ["first"]);
  releaseFirst();
  await eventually(() => starts.length === 2);
  assert.deepEqual(starts, ["first", "second"]);
});

function job(eventId: string): JiraJob {
  return {
    eventId, issueKey: "APP-1", projectKey: "APP", repositoryPath: "/repo", baseBranch: "main",
    branch: `guillermo/${eventId}`, task: "task",
  };
}

function webhookApp(t: TestContext, queue: JobQueue, existingLogs: LogRecord[] = []) {
  const logs = existingLogs;
  const app = createWebhookApp({
    secret,
    projects,
    queue,
    logger: (record) => logs.push(record),
    fastifyLogger: false,
  });
  t.after(() => app.close());
  return { app, logs };
}

function post(app: ReturnType<typeof createWebhookApp>, body: unknown, suppliedSecret?: string) {
  return postRaw(app, JSON.stringify(body), suppliedSecret);
}

function postRaw(app: ReturnType<typeof createWebhookApp>, body: string, suppliedSecret?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (suppliedSecret !== undefined) headers["x-guillermo-webhook-secret"] = suppliedSecret;
  return app.inject({ method: "POST", url: "/webhooks/jira", headers, payload: body });
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition was not met in time.");
}
