import type { JiraJob } from "../integrations/jira/jira.js";

export type EnqueueResult = "accepted" | "duplicate";

export interface JobQueue {
  enqueue(job: JiraJob): Promise<EnqueueResult>;
}

export type JobRunner = (job: JiraJob) => Promise<{ outcome?: string } | void>;

export interface JobQueueLogRecord {
  event: "started" | "completed" | "failed";
  issueKey: string;
  projectKey: string;
  eventId: string;
  outcome?: string;
  errorType?: string;
}

export type JobQueueLogger = (record: JobQueueLogRecord) => void;

export class InProcessJobQueue implements JobQueue {
  private readonly activeEvents = new Set<string>();
  private readonly repositoryTails = new Map<string, Promise<void>>();

  public constructor(private readonly run: JobRunner, private readonly logger: JobQueueLogger) {}

  public enqueue(job: JiraJob): Promise<EnqueueResult> {
    if (this.activeEvents.has(job.eventId)) return Promise.resolve("duplicate");
    this.activeEvents.add(job.eventId);

    const previous = this.repositoryTails.get(job.repositoryPath) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      this.logger(metadata("started", job));
      try {
        const result = await this.run(job);
        this.logger({ ...metadata("completed", job), outcome: result?.outcome ?? "finished" });
      } catch (error) {
        this.logger({ ...metadata("failed", job), errorType: error instanceof Error ? error.name : "UnknownError" });
      }
    }).finally(() => {
      this.activeEvents.delete(job.eventId);
      if (this.repositoryTails.get(job.repositoryPath) === current) this.repositoryTails.delete(job.repositoryPath);
    });
    this.repositoryTails.set(job.repositoryPath, current);
    return Promise.resolve("accepted");
  }
}

function metadata(event: JobQueueLogRecord["event"], job: JiraJob): JobQueueLogRecord {
  return { event, eventId: job.eventId, issueKey: job.issueKey, projectKey: job.projectKey };
}
