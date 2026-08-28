import type { CodingJob } from "./coding-job.js";
import { repositoryIdentity } from "./repository-target.js";

export type EnqueueResult = "accepted" | "duplicate";

export interface JobQueue {
  enqueue(job: CodingJob): Promise<EnqueueResult>;
}

export type JobRunner = (job: CodingJob) => Promise<{ outcome?: string } | void>;

export interface JobQueueLogRecord {
  [key: string]: string | undefined;
  event: "started" | "completed" | "failed";
  eventId: string;
  outcome?: string;
  errorType?: string;
}

export type JobQueueLogger = (record: JobQueueLogRecord) => void;

export class InProcessJobQueue implements JobQueue {
  private readonly activeEvents = new Set<string>();
  private readonly repositoryTails = new Map<string, Promise<void>>();
  private readonly idleWaiters = new Set<() => void>();

  public constructor(private readonly run: JobRunner, private readonly logger: JobQueueLogger) {}

  public enqueue(job: CodingJob): Promise<EnqueueResult> {
    if (this.activeEvents.has(job.source.eventId)) return Promise.resolve("duplicate");
    this.activeEvents.add(job.source.eventId);

    const queueKey = repositoryIdentity(job.repository);
    const previous = this.repositoryTails.get(queueKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      this.logger(metadata("started", job));
      try {
        const result = await this.run(job);
        this.logger({ ...metadata("completed", job), outcome: result?.outcome ?? "finished" });
      } catch (error) {
        this.logger({ ...metadata("failed", job), errorType: error instanceof Error ? error.name : "UnknownError" });
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

function metadata(event: JobQueueLogRecord["event"], job: CodingJob): JobQueueLogRecord {
  return { ...job.source.metadata, event, eventId: job.source.eventId };
}
