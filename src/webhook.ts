import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { JiraJob, JiraProjectMap } from "./jira.js";
import { parseJiraWebhook } from "./jira.js";

const MAX_BODY_BYTES = 256_000;

export interface LogRecord {
  event: "accepted" | "rejected" | "duplicate" | "started" | "completed" | "failed";
  issueKey?: string;
  projectKey?: string;
  eventId?: string;
  reason?: string;
  outcome?: string;
  errorType?: string;
}

export type Logger = (record: LogRecord) => void;
export type JobRunner = (job: JiraJob) => Promise<{ outcome?: string } | void>;

export interface JobQueue {
  enqueue(job: JiraJob): boolean;
}

export interface WebhookServerOptions {
  secret: string;
  projects: JiraProjectMap;
  queue: JobQueue;
  logger?: Logger;
}

export class InProcessJobQueue implements JobQueue {
  private readonly activeEvents = new Set<string>();
  private readonly repositoryTails = new Map<string, Promise<void>>();

  public constructor(private readonly run: JobRunner, private readonly logger: Logger = structuredLogger) {}

  enqueue(job: JiraJob): boolean {
    if (this.activeEvents.has(job.eventId)) return false;
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
    return true;
  }
}

export function createWebhookServer(options: WebhookServerOptions): Server {
  if (Buffer.byteLength(options.secret) < 16) throw new Error("GUILLERMO_JIRA_WEBHOOK_SECRET must be at least 16 bytes.");
  const logger = options.logger ?? structuredLogger;
  return createServer((request, response) => {
    void handleRequest(request, response, options, logger).catch((error: unknown) => {
      logger({ event: "rejected", reason: error instanceof HttpError ? error.reason : "request_error" });
      if (!response.headersSent) sendJson(response, error instanceof HttpError ? error.status : 500, { status: "rejected" });
      else response.end();
    });
  });
}

export function authenticateWebhook(header: string | string[] | undefined, secret: string): boolean {
  if (typeof header !== "string") return false;
  const suppliedDigest = createHash("sha256").update(header, "utf8").digest();
  const expectedDigest = createHash("sha256").update(secret, "utf8").digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebhookServerOptions,
  logger: Logger,
): Promise<void> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== "/webhooks/jira") {
    sendJson(response, 404, { status: "not_found" });
    return;
  }
  if (request.method !== "POST") throw new HttpError(405, "method_not_allowed");
  if (!authenticateWebhook(request.headers["x-guillermo-webhook-secret"], options.secret)) {
    throw new HttpError(401, "authentication_failed");
  }
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new HttpError(415, "content_type_not_json");
  }

  const payload = await readJsonBody(request);
  const parsed = parseJiraWebhook(payload, options.projects);
  if (parsed.kind === "invalid") throw new HttpError(400, parsed.reason);
  if (parsed.kind === "ignored") {
    logger({ event: "rejected", reason: parsed.reason });
    sendJson(response, 200, { status: "ignored" });
    return;
  }

  const queued = options.queue.enqueue(parsed.job);
  if (!queued) {
    logger(metadata("duplicate", parsed.job));
    sendJson(response, 202, { status: "duplicate" });
    return;
  }
  logger(metadata("accepted", parsed.job));
  sendJson(response, 202, { status: "accepted" });
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) throw new HttpError(413, "payload_too_large");
    chunks.push(buffer);
  }
  if (length === 0) throw new HttpError(400, "empty_payload");
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_json");
  }
}

function metadata(event: LogRecord["event"], job: JiraJob): LogRecord {
  return { event, eventId: job.eventId, issueKey: job.issueKey, projectKey: job.projectKey };
}

function sendJson(response: ServerResponse, status: number, body: Record<string, string>): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

function structuredLogger(record: LogRecord): void {
  console.log(JSON.stringify({ timestamp: new Date().toISOString(), ...record }));
}

class HttpError extends Error {
  public constructor(public readonly status: number, public readonly reason: string) {
    super(reason);
  }
}

