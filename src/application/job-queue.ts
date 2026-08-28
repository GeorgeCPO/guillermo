import { performance } from "node:perf_hooks";
import type { CodingJob } from "./coding-job.js";
import type { JobExecutionResult } from "./job-observability.js";
import { repositoryIdentity } from "./repository-target.js";

export type EnqueueResult = "accepted" | "duplicate";

export interface JobQueue {
  enqueue(job: CodingJob): Promise<EnqueueResult>;
}

export type JobRunner = (job: CodingJob) => Promise<JobExecutionResult>;

interface JobCorrelationMetadata {
  eventId: string;
  issueKey?: string;
  projectKey?: string;
}

export type UnexpectedExceptionType = "type_error" | "range_error" | "error" | "unknown";

export type JobQueueLogRecord =
  | (JobCorrelationMetadata & { event: "started" })
  | (JobCorrelationMetadata & JobExecutionResult & { event: "completed"; durationMs: number })
  | (JobCorrelationMetadata & {
    event: "failed";
    outcome: "failed";
    reasonCode: "job_runner_exception";
    exceptionType: UnexpectedExceptionType;
    durationMs: number;
  });

export type JobQueueLogger = (record: JobQueueLogRecord) => void;

export class InProcessJobQueue implements JobQueue {
  private readonly activeEvents = new Set<string>();
  private readonly repositoryTails = new Map<string, Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();

  public constructor(
    private readonly run: JobRunner,
    private readonly logger: JobQueueLogger,
    private readonly now: () => number = () => performance.now(),
  ) {}

  public enqueue(job: CodingJob): Promise<EnqueueResult> {
    if (this.activeEvents.has(job.source.eventId)) return Promise.resolve("duplicate");
    this.activeEvents.add(job.source.eventId);

    const queueKey = repositoryIdentity(job.repository);
    const previous = this.repositoryTails.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const startedAt = this.now();
      this.logger(metadata("started", job));
      try {
        const result = await this.run(job);
        this.logger(completedRecord(job, result, durationMs(startedAt, this.now())));
      } catch (error) {
        this.logger({
          ...metadata("failed", job),
          outcome: "failed",
          reasonCode: "job_runner_exception",
          exceptionType: exceptionType(error),
          durationMs: durationMs(startedAt, this.now()),
        });
      }
    }).finally(() => {
      this.activeEvents.delete(job.source.eventId);
      if (this.repositoryTails.get(queueKey) === current) this.repositoryTails.delete(queueKey);
      if (this.repositoryTails.size === 0) {
        for (const resolve of this.idleWaiters) resolve();
        this.idleWaiters.clear();
      }
    });
    this.repositoryTails.set(queueKey, current);
    return Promise.resolve("accepted");
  }

  public waitForIdle(): Promise<void> {
    if (this.repositoryTails.size === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }
}

function metadata(event: "started", job: CodingJob): Extract<JobQueueLogRecord, { event: "started" }>;
function metadata(event: "completed", job: CodingJob): JobCorrelationMetadata & { event: "completed" };
function metadata(event: "failed", job: CodingJob): JobCorrelationMetadata & { event: "failed" };
function metadata(event: JobQueueLogRecord["event"], job: CodingJob): JobCorrelationMetadata & { event: JobQueueLogRecord["event"] } {
  const record: JobCorrelationMetadata & { event: JobQueueLogRecord["event"] } = {
    event,
    eventId: job.source.eventId,
  };
  if (job.source.metadata.issueKey !== undefined) record.issueKey = job.source.metadata.issueKey;
  if (job.source.metadata.projectKey !== undefined) record.projectKey = job.source.metadata.projectKey;
  return record;
}

function durationMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.round(finishedAt - startedAt));
}

function completedRecord(
  job: CodingJob,
  result: JobExecutionResult,
  elapsed: number,
): Extract<JobQueueLogRecord, { event: "completed" }> {
  const counts = {
    ...metadata("completed", job),
    agentTermination: result.agentTermination,
    agentStepCount: result.agentStepCount,
    changedFileCount: result.changedFileCount,
    testRunCount: result.testRunCount,
    successfulTestRunCount: result.successfulTestRunCount,
    durationMs: elapsed,
  };
  if (result.outcome === "created") return { ...counts, outcome: "created" };
  if (result.outcome === "skipped") {
    return { ...counts, outcome: "skipped", reasonCode: result.reasonCode };
  }
  return { ...counts, outcome: "failed", reasonCode: result.reasonCode };
}

function exceptionType(error: unknown): UnexpectedExceptionType {
  try {
    if (error instanceof TypeError) return "type_error";
    if (error instanceof RangeError) return "range_error";
    if (error instanceof Error) return "error";
    return "unknown";
  } catch {
    return "unknown";
  }
}
