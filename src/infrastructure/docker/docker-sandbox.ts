import { randomUUID } from "node:crypto";
import path from "node:path";
import process from "node:process";
import type { SandboxConfig } from "../../config/sandbox-config.js";
import {
  assertProcessSuccess,
  defaultProcessRunner,
  type ProcessRequest,
  type ProcessResult,
  type ProcessRunner,
} from "../process/process-runner.js";

const CONTAINER_WORKSPACE = "/workspace";
const DOCKER_CONTROL_TIMEOUT_MS = 30_000;
const DOCKER_CONTROL_MAX_OUTPUT_BYTES = 100_000;
const SANDBOX_TMPFS = "/tmp:rw,nosuid,nodev,size=256m,mode=1777";

export interface RepositorySandbox {
  preparationRunner: ProcessRunner;
  testRunner: ProcessRunner;
}

export interface RepositorySandboxProvider {
  assertReady(): Promise<void>;
  forWorkspace(root: string): RepositorySandbox;
}

export interface DockerSandboxDependencies {
  runner: ProcessRunner;
  createId(): string;
  uid: number;
  gid: number;
  controlDirectory: string;
}

const defaultDependencies: DockerSandboxDependencies = {
  runner: defaultProcessRunner,
  createId: randomUUID,
  uid: typeof process.getuid === "function" ? process.getuid() : 65_532,
  gid: typeof process.getgid === "function" ? process.getgid() : 65_532,
  controlDirectory: process.cwd(),
};

export class DockerSandboxProvider implements RepositorySandboxProvider {
  private readonly dependencies: DockerSandboxDependencies;

  public constructor(
    private readonly config: SandboxConfig,
    overrides: Partial<DockerSandboxDependencies> = {},
  ) {
    this.dependencies = { ...defaultDependencies, ...overrides };
    if (!Number.isSafeInteger(this.dependencies.uid) || this.dependencies.uid <= 0) {
      throw new Error("The Guillermo coordinator must run as a non-root user for Docker sandbox ownership mapping.");
    }
    if (!Number.isSafeInteger(this.dependencies.gid) || this.dependencies.gid < 0) {
      throw new Error("The Guillermo coordinator must have a valid group ID for Docker sandbox ownership mapping.");
    }
  }

  async assertReady(): Promise<void> {
    const version = await this.dependencies.runner.run({
      executable: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd: this.dependencies.controlDirectory,
      timeoutMs: DOCKER_CONTROL_TIMEOUT_MS,
      maxOutputBytes: DOCKER_CONTROL_MAX_OUTPUT_BYTES,
    });
    assertProcessSuccess(version, "Docker sandbox availability check");

    const image = await this.dependencies.runner.run({
      executable: "docker",
      args: ["image", "inspect", this.config.image],
      cwd: this.dependencies.controlDirectory,
      timeoutMs: DOCKER_CONTROL_TIMEOUT_MS,
      maxOutputBytes: DOCKER_CONTROL_MAX_OUTPUT_BYTES,
    });
    assertProcessSuccess(image, `Docker sandbox image ${this.config.image}`);
  }

  forWorkspace(root: string): RepositorySandbox {
    assertWorkspaceRoot(root);
    return {
      preparationRunner: new DockerCommandRunner(this.config, root, "bridge", this.dependencies),
      testRunner: new DockerCommandRunner(this.config, root, "none", this.dependencies),
    };
  }
}

type SandboxNetwork = "bridge" | "none";

class DockerCommandRunner implements ProcessRunner {
  public constructor(
    private readonly config: SandboxConfig,
    private readonly workspaceRoot: string,
    private readonly network: SandboxNetwork,
    private readonly dependencies: DockerSandboxDependencies,
  ) {}

  async run(request: ProcessRequest): Promise<ProcessResult> {
    const invalid = validateRequest(request, this.workspaceRoot);
    if (invalid) return processFailure(invalid);

    const containerName = sandboxName(this.dependencies.createId());
    const result = await this.dependencies.runner.run({
      executable: "docker",
      args: dockerRunArguments(
        this.config,
        request,
        this.workspaceRoot,
        this.network,
        containerName,
        this.dependencies.uid,
        this.dependencies.gid,
      ),
      cwd: this.dependencies.controlDirectory,
      ...(request.signal ? { signal: request.signal } : {}),
      ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      ...(request.maxOutputBytes === undefined ? {} : { maxOutputBytes: request.maxOutputBytes }),
    });

    if (result.error?.kind === "timeout" || result.error?.kind === "cancelled" || result.error?.kind === "output-limit") {
      await this.forceRemove(containerName);
    }
    return result;
  }

  private async forceRemove(containerName: string): Promise<void> {
    await this.dependencies.runner.run({
      executable: "docker",
      args: ["container", "rm", "--force", containerName],
      cwd: this.dependencies.controlDirectory,
      timeoutMs: DOCKER_CONTROL_TIMEOUT_MS,
      maxOutputBytes: DOCKER_CONTROL_MAX_OUTPUT_BYTES,
    });
  }
}

function dockerRunArguments(
  config: SandboxConfig,
  request: ProcessRequest,
  workspaceRoot: string,
  network: SandboxNetwork,
  containerName: string,
  uid: number,
  gid: number,
): string[] {
  return [
    "run",
    "--rm",
    "--pull", "never",
    "--name", containerName,
    "--label", "dev.guillermo.sandbox=true",
    "--init",
    "--read-only",
    "--cap-drop", "ALL",
    "--security-opt", "no-new-privileges=true",
    "--network", network,
    "--memory", config.memoryLimit,
    "--memory-swap", config.memoryLimit,
    "--cpus", String(config.cpuLimit),
    "--pids-limit", String(config.pidsLimit),
    "--user", `${uid}:${gid}`,
    "--workdir", CONTAINER_WORKSPACE,
    "--tmpfs", SANDBOX_TMPFS,
    "--env", "HOME=/tmp/home",
    "--env", "CI=1",
    "--env", "npm_config_cache=/tmp/npm-cache",
    "--mount", `type=bind,src=${workspaceRoot},dst=${CONTAINER_WORKSPACE}`,
    "--mount", `type=bind,src=${path.join(workspaceRoot, ".git")},dst=${CONTAINER_WORKSPACE}/.git,readonly`,
    config.image,
    request.executable,
    ...request.args,
  ];
}

function validateRequest(request: ProcessRequest, workspaceRoot: string): string | undefined {
  if (request.cwd !== workspaceRoot) return "Sandbox commands must run from the managed workspace root.";
  if (request.executable !== "npm") return "Stage 10 remote sandboxes support npm commands only.";
  if (request.input !== undefined) return "Sandbox commands do not accept standard input.";
  return undefined;
}

function assertWorkspaceRoot(root: string): void {
  if (!path.isAbsolute(root) || root.includes(",") || /[\0\r\n]/.test(root)) {
    throw new Error("Docker sandbox workspace must be an absolute path without commas or control characters.");
  }
}

function sandboxName(id: string): string {
  const safeId = id.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").slice(0, 48);
  return `guillermo-sandbox-${safeId || "job"}`;
}

function processFailure(message: string): ProcessResult {
  return {
    exitCode: null,
    stdout: "",
    stderr: "",
    error: { kind: "spawn", message },
  };
}
