import { execa } from "execa";

export const DEFAULT_MAX_OUTPUT_BYTES = 500_000;

export interface ProcessRequest {
  executable: string;
  args: readonly string[];
  cwd: string;
  input?: string;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

export type ProcessErrorKind = "nonzero-exit" | "spawn" | "output-limit" | "cancelled";

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
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        error: {
          kind: "spawn",
          message: error instanceof Error ? error.message : String(error),
        },
      };
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
  if (result.isCanceled || result.timedOut) return "cancelled";
  return typeof result.exitCode === "number" ? "nonzero-exit" : "spawn";
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
