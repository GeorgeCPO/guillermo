import assert from "node:assert/strict";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import type { JiraJob } from "./jira.js";
import { createWebhookServer, InProcessJobQueue, type JobQueue, type LogRecord } from "./webhook.js";

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
  const { port } = await listen(t, queue);

  const missing = await post(port, webhookPayload());
  const invalid = await post(port, webhookPayload(), "wrong-secret-value");
  const malformedButUnauthenticated = await postRaw(port, "not-json");

  assert.equal(missing.statusCode, 401);
  assert.equal(invalid.statusCode, 401);
  assert.equal(malformedButUnauthenticated.statusCode, 401);
  assert.equal(enqueueCalls, 0);
  assert.doesNotMatch(missing.body, /secret|correct-horse/i);
});

test("non-trigger events are filtered without dispatching work", async (t) => {
  let enqueueCalls = 0;
  const queue: JobQueue = { enqueue: () => { enqueueCalls += 1; return true; } };
  const { port, logs } = await listen(t, queue);
  const candidate = webhookPayload();
  candidate.webhookEvent = "issue_updated";

  const response = await post(port, candidate, secret);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { status: "ignored" });
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
  const running = await listen(t, queue, logs);

  const response = await post(running.port, webhookPayload(), secret);
  assert.equal(response.statusCode, 202);
  assert.deepEqual(JSON.parse(response.body), { status: "accepted" });
  assert.equal(started, true);
  assert.equal(logs.some(({ event }) => event === "completed"), false);

  resolveRun();
  await eventually(() => logs.some(({ event }) => event === "completed"));
  assert.equal(logs.find(({ event }) => event === "completed")?.outcome, "created");
});

test("duplicate deliveries do not start the same active event twice", async (t) => {
  let resolveRun!: () => void;
  const blocker = new Promise<void>((resolve) => { resolveRun = resolve; });
  let runs = 0;
  const logs: LogRecord[] = [];
  const queue = new InProcessJobQueue(async () => { runs += 1; await blocker; }, (record) => logs.push(record));
  const running = await listen(t, queue, logs);

  const first = await post(running.port, webhookPayload(), secret);
  const duplicate = await post(running.port, webhookPayload(), secret);
  assert.equal(first.statusCode, 202);
  assert.deepEqual(JSON.parse(duplicate.body), { status: "duplicate" });
  assert.equal(runs, 1);
  assert.equal(logs.filter(({ event }) => event === "duplicate").length, 1);
  resolveRun();
});

test("the in-process queue serializes separate jobs for the same repository", async () => {
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const starts: string[] = [];
  const queue = new InProcessJobQueue(async (job) => {
    starts.push(job.eventId);
    if (job.eventId === "first") await firstBlocked;
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

async function listen(t: { after(callback: () => Promise<void>): void }, queue: JobQueue, existingLogs: LogRecord[] = []) {
  const logs = existingLogs;
  const server = createWebhookServer({ secret, projects, queue, logger: (record) => logs.push(record) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  return { port: (server.address() as AddressInfo).port, logs };
}

function post(port: number, body: unknown, suppliedSecret?: string) {
  return postRaw(port, JSON.stringify(body), suppliedSecret);
}

function postRaw(port: number, body: string, suppliedSecret?: string): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (suppliedSecret !== undefined) headers["x-guillermo-webhook-secret"] = suppliedSecret;
    const outgoing = request({ host: "127.0.0.1", port, path: "/webhooks/jira", method: "POST", headers }, (response) => {
      let responseBody = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { responseBody += chunk; });
      response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, body: responseBody }));
    });
    outgoing.on("error", reject);
    outgoing.end(body);
  });
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition was not met in time.");
}

