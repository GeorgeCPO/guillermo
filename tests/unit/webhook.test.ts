import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { CodingJob } from "../../src/application/coding-job.js";
import type { JobQueue } from "../../src/application/job-queue.js";
import { createWebhookApp, type LogRecord } from "../../src/entrypoints/http/server.js";

const secret = "correct-horse-battery-staple";
const projects = { APP: { repository: { owner: "my-org", name: "app" }, baseBranch: "main" } } as const;

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
  const queue: JobQueue = { enqueue: async () => { enqueueCalls += 1; return "accepted"; } };
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
  const { app } = webhookApp(t, fakeQueue());
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
  const { app } = webhookApp(t, { enqueue: async () => { enqueueCalls += 1; return "accepted"; } });

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
  const { app } = webhookApp(t, fakeQueue());
  const response = await postRaw(app, JSON.stringify({ padding: "x".repeat(256_000) }), secret);

  assert.equal(response.statusCode, 413);
  assert.deepEqual(response.json(), { status: "rejected" });
});

test("non-trigger events are filtered without dispatching work", async (t) => {
  let enqueueCalls = 0;
  const queue: JobQueue = { enqueue: async () => { enqueueCalls += 1; return "accepted"; } };
  const { app, logs } = webhookApp(t, queue);
  const candidate = webhookPayload();
  candidate.webhookEvent = "issue_updated";

  const response = await post(app, candidate, secret);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ignored" });
  assert.equal(enqueueCalls, 0);
  assert.equal(logs.at(-1)?.event, "rejected");
});

test("accepted requests dispatch the parsed job and return 202", async (t) => {
  const dispatchedJobs: CodingJob[] = [];
  const logs: LogRecord[] = [];
  const queue: JobQueue = { enqueue: async (job) => { dispatchedJobs.push(job); return "accepted"; } };
  const { app } = webhookApp(t, queue, logs);

  const response = await post(app, webhookPayload(), secret);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(response.json(), { status: "accepted" });
  assert.equal(dispatchedJobs[0]?.source.eventId, "APP-42:comment:9001");
  assert.deepEqual(dispatchedJobs[0]?.source.metadata, { issueKey: "APP-42", projectKey: "APP" });
  assert.deepEqual(dispatchedJobs[0]?.repository, { owner: "my-org", name: "app" });
  assert.doesNotMatch(JSON.stringify(logs), /correct-horse|Cover edge cases/);
});

test("Fastify logs webhook metadata without secrets or issue descriptions", async (t) => {
  let output = "";
  const app = createWebhookApp({
    secret,
    projects,
    queue: fakeQueue(),
    fastifyLogger: { stream: { write: (chunk: string) => { output += chunk; } } },
  });
  t.after(() => app.close());

  const response = await post(app, webhookPayload(), secret);

  assert.equal(response.statusCode, 202);
  assert.match(output, /"event":"accepted"/);
  assert.doesNotMatch(output, /correct-horse|Cover edge cases/);
});

test("duplicate queue results return duplicate without logging accepted", async (t) => {
  const logs: LogRecord[] = [];
  const queue: JobQueue = { enqueue: async () => "duplicate" };
  const { app } = webhookApp(t, queue, logs);

  const duplicate = await post(app, webhookPayload(), secret);
  assert.equal(duplicate.statusCode, 202);
  assert.deepEqual(duplicate.json(), { status: "duplicate" });
  assert.equal(logs.filter(({ event }) => event === "duplicate").length, 1);
  assert.equal(logs.some(({ event }) => event === "accepted"), false);
});

test("unknown routes return 404 and unsupported Jira methods return 405", async (t) => {
  const { app } = webhookApp(t, fakeQueue());

  const unknown = await app.inject({ method: "POST", url: "/unknown" });
  const unsupportedMethod = await app.inject({ method: "GET", url: "/webhooks/jira" });

  assert.equal(unknown.statusCode, 404);
  assert.deepEqual(unknown.json(), { status: "not_found" });
  assert.equal(unsupportedMethod.statusCode, 405);
  assert.deepEqual(unsupportedMethod.json(), { status: "rejected" });
});

test("health endpoint returns only minimal non-sensitive status", async (t) => {
  const { app } = webhookApp(t, fakeQueue());
  const response = await app.inject({ method: "GET", url: "/healthz" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.deepEqual(response.json(), { status: "ok" });
  assert.doesNotMatch(response.body, /project|docker|workspace|secret|repository|job/i);

  const wrongMethod = await app.inject({ method: "POST", url: "/healthz" });
  assert.equal(wrongMethod.statusCode, 405);
});

test("webhook secrets must contain at least 16 bytes", () => {
  assert.throws(
    () => createWebhookApp({ secret: "too-short", projects, queue: fakeQueue(), fastifyLogger: false }),
    /at least 16 bytes/,
  );
});

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

function fakeQueue(): JobQueue {
  return { enqueue: async () => "accepted" };
}

function post(app: ReturnType<typeof createWebhookApp>, body: unknown, suppliedSecret?: string) {
  return postRaw(app, JSON.stringify(body), suppliedSecret);
}

function postRaw(app: ReturnType<typeof createWebhookApp>, body: string, suppliedSecret?: string) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (suppliedSecret !== undefined) headers["x-guillermo-webhook-secret"] = suppliedSecret;
  return app.inject({ method: "POST", url: "/webhooks/jira", headers, payload: body });
}
