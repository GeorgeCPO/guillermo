import process from "node:process";
import type { FastifyInstance } from "fastify";

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 30_000;

export type ShutdownResult = "drained" | "timed-out";

export interface ClosableHttpServer {
  close(): Promise<unknown> | void;
}

export async function shutdownCoordinator(
  app: ClosableHttpServer,
  waitForJobs: () => Promise<void>,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): Promise<ShutdownResult> {
  await app.close();
  return waitUntilSettled(waitForJobs(), timeoutMs);
}

export function installShutdownHandlers(
  app: FastifyInstance,
  waitForJobs: () => Promise<void>,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS,
): void {
  let shuttingDown = false;
  const handle = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ event: "shutdown_started", signal });
    try {
      const result = await shutdownCoordinator(app, waitForJobs, timeoutMs);
      app.log.info({ event: "shutdown_completed", result });
      process.exit(result === "drained" ? 0 : 1);
    } catch (error) {
      app.log.error({ err: error }, "Failed to shut down webhook server cleanly");
      process.exit(1);
    }
  };
  process.once("SIGTERM", handle);
  process.once("SIGINT", handle);
}

async function waitUntilSettled(promise: Promise<void>, timeoutMs: number): Promise<ShutdownResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("Shutdown timeout must be a positive integer.");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => "drained" as const),
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(() => resolve("timed-out"), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
