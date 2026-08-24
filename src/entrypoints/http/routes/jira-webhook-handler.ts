import { createHash, timingSafeEqual } from "node:crypto";
import type { onRequestHookHandler, RouteHandlerMethod } from "fastify";
import type { CodingJob } from "../../../application/coding-job.js";
import type { JobQueue } from "../../../application/job-queue.js";
import { parseJiraWebhook, type JiraProjectMap } from "../../../integrations/jira/jira.js";
import { HttpError } from "../http-error.js";

export interface LogRecord {
  event: "accepted" | "rejected" | "duplicate";
  issueKey?: string;
  projectKey?: string;
  eventId?: string;
  reason?: string;
  outcome?: string;
  errorType?: string;
}

export type Logger = (record: LogRecord) => void;

export interface JiraWebhookHandlerOptions {
  projects: JiraProjectMap;
  queue: JobQueue;
  logger: Logger;
}

export function createJiraWebhookHandler(options: JiraWebhookHandlerOptions): RouteHandlerMethod {
  return async (request, reply) => {
    const parsed = parseJiraWebhook(request.body, options.projects);
    if (parsed.kind === "invalid") throw new HttpError(400, parsed.reason);
    if (parsed.kind === "ignored") {
      options.logger({ event: "rejected", reason: parsed.reason });
      return reply.status(200).send({ status: "ignored" });
    }

    const result = await options.queue.enqueue(parsed.job);
    if (result === "duplicate") {
      options.logger(metadata("duplicate", parsed.job));
      return reply.status(202).send({ status: "duplicate" });
    }
    options.logger(metadata("accepted", parsed.job));
    return reply.status(202).send({ status: "accepted" });
  };
}

export function createJiraWebhookOnRequest(secret: string): onRequestHookHandler {
  return async (request) => {
    if (!authenticateWebhook(request.headers["x-guillermo-webhook-secret"], secret)) {
      throw new HttpError(401, "authentication_failed");
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      throw new HttpError(415, "content_type_not_json");
    }
  };
}

export function authenticateWebhook(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string") return false;
  const suppliedDigest = createHash("sha256").update(header, "utf8").digest();
  const expectedDigest = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function metadata(event: LogRecord["event"], job: CodingJob): LogRecord {
  return {
    event,
    eventId: job.source.eventId,
    issueKey: job.source.metadata.issueKey,
    projectKey: job.source.metadata.projectKey,
  };
}
