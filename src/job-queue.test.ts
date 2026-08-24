import assert from "node:assert/strict";
import test from "node:test";
import type { JiraJob } from "./jira.js";
import { InProcessJobQueue, type JobQueueLogRecord } from "./job-queue.js";

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
    starts.push(candidate.eventId);
    if (candidate.eventId === "first") await firstRun.promise;
  }, (record) => logs.push(record));

  assert.equal(await queue.enqueue(job("first")), "accepted");
  assert.equal(await queue.enqueue(job("second")), "accepted");
  await eventually(() => starts.length === 1);
  assert.deepEqual(starts, ["first"]);

  firstRun.resolve();
  await eventually(() => completed(logs, "second") === 1);
  assert.deepEqual(starts, ["first", "second"]);
});

test("jobs for different repositories can start concurrently", async () => {
  const releases = new Map([["first", deferred<void>()], ["second", deferred<void>()]]);
  const starts: string[] = [];
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.eventId);
    await releases.get(candidate.eventId)?.promise;
  }, (record) => logs.push(record));

  assert.equal(await queue.enqueue(job("first", "/repo/one")), "accepted");
  assert.equal(await queue.enqueue(job("second", "/repo/two")), "accepted");
  await eventually(() => starts.length === 2);
  assert.deepEqual(new Set(starts), new Set(["first", "second"]));

  releases.get("first")?.resolve();
  releases.get("second")?.resolve();
  await eventually(() => logs.filter(({ event }) => event === "completed").length === 2);
});

test("a failed job is logged and does not block the next job for its repository", async () => {
  const starts: string[] = [];
  const logs: JobQueueLogRecord[] = [];
  const queue = new InProcessJobQueue(async (candidate) => {
    starts.push(candidate.eventId);
    if (candidate.eventId === "first") throw new TypeError("sensitive task details");
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

function job(eventId: string, repositoryPath = "/repo"): JiraJob {
  return {
    eventId,
    issueKey: "APP-1",
    projectKey: "APP",
    repositoryPath,
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
