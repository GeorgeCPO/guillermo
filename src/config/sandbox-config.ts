export interface SandboxConfig {
  image: string;
  memoryLimit: string;
  cpuLimit: number;
  pidsLimit: number;
}

const DEFAULT_IMAGE = "guillermo-worker:latest";
const DEFAULT_MEMORY_LIMIT = "1g";
const DEFAULT_CPU_LIMIT = 2;
const DEFAULT_PIDS_LIMIT = 256;
const MAX_IMAGE_LENGTH = 255;
const MIN_MEMORY_BYTES = 64 * 1_024 * 1_024;
const MAX_MEMORY_BYTES = 64 * 1_024 * 1_024 * 1_024;
const MIN_CPU_LIMIT = 0.1;
const MAX_CPU_LIMIT = 64;
const MIN_PIDS_LIMIT = 16;
const MAX_PIDS_LIMIT = 4_096;

export function loadSandboxConfig(environment: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const image = environment.GUILLERMO_DOCKER_IMAGE ?? DEFAULT_IMAGE;
  if (
    image.length === 0
    || image.length > MAX_IMAGE_LENGTH
    || image.trim() !== image
    || image.startsWith("-")
    || /[\s\0\r\n]/.test(image)
  ) {
    throw new Error("GUILLERMO_DOCKER_IMAGE must be a valid single-line Docker image reference.");
  }

  const memoryLimit = environment.GUILLERMO_DOCKER_MEMORY ?? DEFAULT_MEMORY_LIMIT;
  if (!validMemoryLimit(memoryLimit)) {
    throw new Error("GUILLERMO_DOCKER_MEMORY must be a Docker memory value from 64m through 64g.");
  }

  const cpuLimit = numberInRange(
    environment.GUILLERMO_DOCKER_CPUS,
    DEFAULT_CPU_LIMIT,
    MIN_CPU_LIMIT,
    MAX_CPU_LIMIT,
    "GUILLERMO_DOCKER_CPUS",
  );
  const pidsLimit = integerInRange(
    environment.GUILLERMO_DOCKER_PIDS,
    DEFAULT_PIDS_LIMIT,
    MIN_PIDS_LIMIT,
    MAX_PIDS_LIMIT,
    "GUILLERMO_DOCKER_PIDS",
  );

  return { image, memoryLimit, cpuLimit, pidsLimit };
}

function validMemoryLimit(value: string): boolean {
  const match = /^(?<amount>[1-9][0-9]*)(?<unit>[bkmg])$/i.exec(value);
  if (!match?.groups) return false;
  const amount = Number(match.groups.amount);
  const multipliers: Readonly<Record<string, number>> = {
    b: 1,
    k: 1_024,
    m: 1_024 * 1_024,
    g: 1_024 * 1_024 * 1_024,
  };
  const bytes = amount * (multipliers[match.groups.unit?.toLowerCase() ?? ""] ?? 0);
  return Number.isSafeInteger(bytes) && bytes >= MIN_MEMORY_BYTES && bytes <= MAX_MEMORY_BYTES;
}

function numberInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be a number from ${minimum} through ${maximum}.`);
  }
  return parsed;
}

function integerInRange(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer from ${minimum} through ${maximum}.`);
  }
  return parsed;
}
