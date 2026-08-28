import assert from "node:assert/strict";
import test from "node:test";
import type { CodingJob } from "../../src/application/coding-job.js";
import { InProcessJobQueue, type JobQueueLogRecord } from "../../src/application/job-queue.js";

test("duplicate active event IDs are rejected and become eligible after completion", async () => {
  const firstRun = deferred<void>();
  let runs = 0;
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async () => {
    runs += 1;
    if (runs === 1) await firstRun.promise;
  }, (record) => logs.push(record));

  assert.equal(await queue.enqueue(job("same")), "accepted");
  assert.equal(await queue.enqueue(job("same")), "duplicate");
  assert.equal(runs, 1);

  firstRun.resolve();
  await eventually(() => completed(logs, "same") === 1);
  assert.equal(await queue.enqueue(job("same")), "accepted");
  await eventually(() => completed(logs, "same") === 2);
  assert.equal(runs, 2);
});

test("separate jobs for the same repository execute serially", async () => {
  const firstRun = deferred<void>();
  const starts: string[] = [];
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.source.eventId);
    if (candidate.source.eventId === "first") await firstRun.promise;
  }, (record) => logs.push(record));

  assert.equal(await queue.enqueue(job("first")), "accepted");
  assert.equal(await queue.enqueue(job("second")), "accepted");
  await eventually(() => starts.length === 1);
  assert.deepEqual(starts, ["first"]);

  firstRun.resolve();
  await eventually(() => completed(logs, "second") === 1);
  assert.deepEqual(starts, ["first", "second"]);
});

test("repository serialization uses a canonical case-insensitive GitHub identity", async () => {
  const release = deferred<void>();
  const starts: string[] = [];
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.source.eventId);
    if (candidate.source.eventId === "first") await release.promise;
  }, (record) => logs.push(record));
  const first = job("first");
  const second = job("second");
  second.repository = { owner: "ACME", name: "REPO" };
  await queue.enqueue(first);
  await queue.enqueue(second);
  await eventually(() => starts.length === 1);
  assert.deepEqual(starts, ["first"]);
  release.resolve();
  await eventually(() => completed(logs, "second") === 1);
  assert.deepEqual(starts, ["first", "second"]);
});

test("jobs for different repositories can start concurrently", async () => {
  const releases = new Map([["first", deferred<void>()], ["second", deferred<void>()]]);
  const starts: string[] = [];
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.source.eventId);
    await releases.get(candidate.source.eventId)?.promise;
  }, (record) => logs.push(record));

  assert.equal(await queue.enqueue(job("first", "one")), "accepted");
  assert.equal(await queue.enqueue(job("second", "two")), "accepted");
  await eventually(() => starts.length === 2);
  assert.deepEqual(new Set(starts), new Set(["first", "second"]));

  releases.get("first")?.resolve();
  releases.get("second")?.resolve();
  await eventually(() => logs.filter(({ event }) => event === "completed").length === 2);
});

test("queue behavior depends on application source metadata rather than Jira job fields", async () => {
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async () => ({ outcome: "finished" }), (record) => logs.push(record));
  const codingJob: CodingJob = {
    source: { eventId: "request-1", metadata: { requestId: "external-42" } },
    repository: { owner: "acme", name: "repo" },
    baseBranch: "main",
    branch: "guillermo/request-1",
    task: "Implement a change",
  };

  assert.equal(await queue.enqueue(codingJob), "accepted");
  await eventually(() => completed(logs, "request-1") === 1);
  assert.deepEqual(logs[0], { event: "started", eventId: "request-1", requestId: "external-42" });
});

test("a failed job is logged and does not block the next job for its repository", async () => {
  const starts: string[] = [];
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.source.eventId);
    if (candidate.source.eventId === "first") throw new TypeError("sensitive task details");
    return { outcome: "created" };
  }, (record) => logs.push(record));

  assert.equal(await queue.enqueue(job("first")), "accepted");
  assert.equal(await queue.enqueue(job("second")), "accepted");
  await eventually(() => completed(logs, "second") === 1);

  assert.deepEqual(starts, ["first", "second"]);
  assert.deepEqual(logs.find(({ event }) => event === "failed"), {
    event: "failed", eventId: "first", issueKey: "APP-1", projectKey: "APP", errorType: "TypeError",
  });
  assert.equal(logs.find(({ event, eventId }) => event === "completed" && eventId === "second")?.outcome, "created");
  assert.doesNotMatch(JSON.stringify(logs), /task text|issue description|sensitive task details/);

  assert.equal(await queue.enqueue(job("first")), "accepted");
  await eventually(() => logs.filter(({ event, eventId }) => event === "failed" && eventId === "first").length === 2);
});

test("waitForIdle resolves only after all active repository queues drain", async () => {
  const release = deferred<void>();
  const queue = new InProcessJobQueue(async () => release.promise, () => undefined);
  await queue.enqueue(job("active"));
  let idle = false;
  const waiting = queue.waitForIdle().then(() => { idle = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(idle, false);
  release.resolve();
  await waiting;
  assert.equal(idle, true);
  await queue.waitForIdle();
});

function job(eventId: string, repositoryName = "repo"): CodingJob {
  return {
    source: { eventId, metadata: { issueKey: "APP-1", projectKey: "APP" } },
    repository: { owner: "acme", name: repositoryName },
    baseBranch: "main",
    branch: `guillermo/${eventId}`,
    task: "task text with issue description and a secret",
  };
}

function completed(logs: JobQueueLogRecord[], eventId: string): number {
  return logs.filter(({ event, eventId: loggedEventId }) => event === "completed" && loggedEventId === eventId).length;
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempts = 0; attempts < 100; attempts += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Condition was not met in time.");
}
