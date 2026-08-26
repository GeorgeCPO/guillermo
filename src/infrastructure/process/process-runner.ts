import { execa } from "execa";

export const DEFAULT_MAX_OUTPUT_BYTES = 500_000;

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  env?: Readonly<Record<string, string>>;
}

export type ProcessErrorKind = "nonzero-exit" | "spawn" | "output-limit" | "cancelled" | "timeout";

export interface ProcessErrorInfo {
  kind: ProcessErrorKind;
  message: string;
  code?: string;
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  error?: ProcessErrorInfo;
}

export interface ProcessRunner {
  run(request: ProcessRequest): Promise<ProcessResult>;
}

export class ProcessExecutionError extends Error {
  public constructor(
    message: string,
    public readonly result: ProcessResult,
  ) {
    super(message);
    this.name = "ProcessExecutionError";
  }

  get exitCode(): number | null {
    return this.result.exitCode;
  }
}

export class ExecaProcessRunner implements ProcessRunner {
  async run(request: ProcessRequest): Promise<ProcessResult> {
    const maxOutputBytes = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    try {
      const result = await execa(request.executable, [...request.args], {
        cwd: request.cwd,
        input: request.input,
        maxBuffer: maxOutputBytes,
        reject: false,
        shell: false,
        signal: request.signal,
        timeout: request.timeoutMs,
        ...(request.env ? { env: request.env, extendEnv: false } : {}),
        stripFinalNewline: false,
      });
      const stdout = boundOutput(asText(result.stdout), maxOutputBytes);
      const stderr = boundOutput(asText(result.stderr), maxOutputBytes);
      const exitCode = typeof result.exitCode === "number" ? result.exitCode : null;
      const error = result.failed
        ? {
            kind: normalizeErrorKind(result),
            message: result.shortMessage || result.message || `${request.executable} failed`,
            ...(typeof result.code === "string" ? { code: result.code } : {}),
          }
        : undefined;
      return { exitCode, stdout, stderr, ...(error ? { error } : {}) };
    } catch (error) {
      const failure = processFailure(error, maxOutputBytes, request.signal?.aborted === true);
      return { exitCode: failure.exitCode, stdout: failure.stdout, stderr: failure.stderr, error: failure.error };
    }
  }
}

export const defaultProcessRunner: ProcessRunner = new ExecaProcessRunner();

export function assertProcessSuccess(result: ProcessResult, description: string): ProcessResult {
  if (result.exitCode === 0 && !result.error) return result;
  const detail = result.stderr.trim() || result.error?.message || `exited with ${result.exitCode ?? "no exit code"}`;
  throw new ProcessExecutionError(`${description}: ${detail}`, result);
}

function normalizeErrorKind(result: {
  exitCode?: number;
  isMaxBuffer?: boolean;
  isCanceled?: boolean;
  timedOut?: boolean;
}): ProcessErrorKind {
  if (result.isMaxBuffer) return "output-limit";
  if (result.timedOut) return "timeout";
  if (result.isCanceled) return "cancelled";
  return typeof result.exitCode === "number" ? "nonzero-exit" : "spawn";
}

function processFailure(error: unknown, maxOutputBytes: number, signalAborted: boolean): ProcessResult {
  if (!isProcessLikeError(error)) {
    return { exitCode: null, stdout: "", stderr: "", error: { kind: "spawn", message: String(error) } };
  }
  const stdout = boundOutput(asText(error.stdout), maxOutputBytes);
  const stderr = boundOutput(asText(error.stderr), maxOutputBytes);
  return {
    exitCode: typeof error.exitCode === "number" ? error.exitCode : null,
    stdout,
    stderr,
    error: {
      kind: signalAborted || error.name === "AbortError" || error.code === "ABORT_ERR" ? "cancelled" : normalizeErrorKind(error),
      message: error.shortMessage || error.message || "Process failed",
      ...(typeof error.code === "string" ? { code: error.code } : {}),
    },
  };
}

function isProcessLikeError(error: unknown): error is Error & {
  exitCode?: number;
  stdout?: unknown;
  stderr?: unknown;
  shortMessage?: string;
  code?: string;
  isMaxBuffer?: boolean;
  isCanceled?: boolean;
  timedOut?: boolean;
} {
  return error instanceof Error;
}

function asText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output instanceof Uint8Array) return Buffer.from(output).toString("utf8");
  return output === undefined ? "" : String(output);
}

function boundOutput(output: string, maxBytes: number): string {
  const bytes = Buffer.from(output);
  return bytes.byteLength <= maxBytes ? output : bytes.subarray(0, maxBytes).toString("utf8");
}
