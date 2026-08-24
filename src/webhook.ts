import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { JiraJob, JiraProjectMap } from "./jira.js";
import { parseJiraWebhook } from "./jira.js";
import type { JobQueue } from "./job-queue.js";

const MAX_BODY_BYTES = 256_000;
const JIRA_WEBHOOK_PATH = "/webhooks/jira";

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

export interface WebhookAppOptions {
  secret: string;
  projects: JiraProjectMap;
  queue: JobQueue;
  logger?: Logger;
  fastifyLogger?: FastifyServerOptions["logger"];
}

export function createWebhookApp(options: WebhookAppOptions): FastifyInstance {
  if (Buffer.byteLength(options.secret) < 16) throw new Error("GUILLERMO_JIRA_WEBHOOK_SECRET must be at least 16 bytes.");

  const app = Fastify({
    bodyLimit: MAX_BODY_BYTES,
    logController: new LogController({ disableRequestLogging: true }),
    logger: options.fastifyLogger ?? {
      level: "info",
      redact: {
        paths: [
          "req.headers.x-guillermo-webhook-secret",
          "request.headers.x-guillermo-webhook-secret",
          "req.body",
          "request.body",
          "body",
        ],
        remove: true,
      },
    },
  });
  const logger = options.logger ?? ((record: LogRecord) => app.log.info(record));

  app.setErrorHandler((error, _request, reply) => {
    const rejection = rejectionFor(error);
    logger({ event: "rejected", reason: rejection.reason });
    return reply.status(rejection.status).send({ status: "rejected" });
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname === JIRA_WEBHOOK_PATH) {
      logger({ event: "rejected", reason: "method_not_allowed" });
      return reply.status(405).send({ status: "rejected" });
    }
    return reply.status(404).send({ status: "not_found" });
  });

  app.post(JIRA_WEBHOOK_PATH, {
    onRequest: async (request) => {
      if (!authenticateWebhook(request.headers["x-guillermo-webhook-secret"], options.secret)) {
        throw new HttpError(401, "authentication_failed");
      }
      if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
        throw new HttpError(415, "content_type_not_json");
      }
    },
  }, async (request, reply) => {
    const parsed = parseJiraWebhook(request.body, options.projects);
    if (parsed.kind === "invalid") throw new HttpError(400, parsed.reason);
    if (parsed.kind === "ignored") {
      logger({ event: "rejected", reason: parsed.reason });
      return reply.status(200).send({ status: "ignored" });
    }

    const result = await options.queue.enqueue(parsed.job);
    if (result === "duplicate") {
      logger(metadata("duplicate", parsed.job));
      return reply.status(202).send({ status: "duplicate" });
    }
    logger(metadata("accepted", parsed.job));
    return reply.status(202).send({ status: "accepted" });
  });

  return app;
}

export function authenticateWebhook(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string") return false;
  const suppliedDigest = createHash("sha256").update(header, "utf8").digest();
  const expectedDigest = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

function rejectionFor(error: unknown): { status: number; reason: string } {
  if (error instanceof HttpError) return { status: error.status, reason: error.reason };
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return { status: 413, reason: "payload_too_large" };
  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY") return { status: 400, reason: "empty_payload" };
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY") return { status: 400, reason: "invalid_json" };
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return { status: 415, reason: "content_type_not_json" };
  const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : 500;
  return { status: statusCode, reason: "request_error" };
}

function metadata(event: LogRecord["event"], job: JiraJob): LogRecord {
  return { event, eventId: job.eventId, issueKey: job.issueKey, projectKey: job.projectKey };
}

class HttpError extends Error {
  public constructor(public readonly status: number, public readonly reason: string) {
    super(reason);
  }
}
