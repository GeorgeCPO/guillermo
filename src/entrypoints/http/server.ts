import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from "fastify";
import type { JiraProjectMap } from "../../integrations/jira/jira.js";
import type { JobQueue } from "../../application/job-queue.js";
import { HttpError } from "./http-error.js";
import { createRouteHandlers } from "./routes/handlers.js";
import {
  type Logger,
  type LogRecord,
} from "./routes/jira-webhook-handler.js";

export type { Logger, LogRecord } from "./routes/jira-webhook-handler.js";

const MAX_BODY_BYTES = 256_000;
const MIN_WEBHOOK_SECRET_BYTES = 16;
export const HEALTH_PATH = "/healthz";
export interface WebhookAppOptions {
  secret: string;
  projects: JiraProjectMap;
  queue: JobQueue;
  logger?: Logger;
  fastifyLogger?: FastifyServerOptions["logger"];
}

export function createWebhookApp(options: WebhookAppOptions): FastifyInstance {
  if (Buffer.byteLength(options.secret) < MIN_WEBHOOK_SECRET_BYTES) {
    throw new Error("GUILLERMO_JIRA_WEBHOOK_SECRET must be at least 16 bytes.");
  }

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
  const handlers = createRouteHandlers({
    secret: options.secret,
    projects: options.projects,
    queue: options.queue,
    logger,
  });

  app.get(HEALTH_PATH, async (_request, reply) => {
    reply.header("cache-control", "no-store");
    return { status: "ok" };
  });

  app.setErrorHandler((error, _request, reply) => {
    const rejection = rejectionFor(error);
    logger({ event: "rejected", reason: rejection.reason });
    return reply.status(rejection.status).send({ status: "rejected" });
  });

  app.setNotFoundHandler((request, reply) => {
    const pathname = new URL(request.url, "http://localhost").pathname;
    if (pathname in handlers || pathname === HEALTH_PATH) {
      logger({ event: "rejected", reason: "method_not_allowed" });
      return reply.status(405).send({ status: "rejected" });
    }
    return reply.status(404).send({ status: "not_found" });
  });

  for (const [url, route] of Object.entries(handlers)) {
    app.route({ url, ...route });
  }

  return app;
}

function rejectionFor(error: unknown): { status: number; reason: string } {
  if (error instanceof HttpError) return { status: error.status, reason: error.reason };
  const code = error instanceof Error && "code" in error ? error.code : undefined;
  if (code === "FST_ERR_CTP_BODY_TOO_LARGE") return { status: 413, reason: "payload_too_large" };
  if (code === "FST_ERR_CTP_EMPTY_JSON_BODY") return { status: 400, reason: "empty_payload" };
  if (code === "FST_ERR_CTP_INVALID_JSON_BODY") {
    return { status: 400, reason: "invalid_json" }
  };
  if (code === "FST_ERR_CTP_INVALID_MEDIA_TYPE") return { status: 415, reason: "content_type_not_json" };
  const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : 500;
  return { status: statusCode, reason: "request_error" };
}
