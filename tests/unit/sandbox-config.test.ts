import assert from "node:assert/strict";
import test from "node:test";
import { loadSandboxConfig } from "../../src/config/sandbox-config.js";

test("sandbox configuration supplies bounded defaults and accepts explicit limits", () => {
  assert.deepEqual(loadSandboxConfig({}), {
    image: "guillermo-worker:latest",
    memoryLimit: "1g",
    cpuLimit: 2,
    pidsLimit: 256,
  });
  assert.deepEqual(loadSandboxConfig({
    GUILLERMO_DOCKER_IMAGE: "registry.example.test/guillermo-worker@sha256:abc",
    GUILLERMO_DOCKER_MEMORY: "768m",
    GUILLERMO_DOCKER_CPUS: "1.5",
    GUILLERMO_DOCKER_PIDS: "128",
  }), {
    image: "registry.example.test/guillermo-worker@sha256:abc",
    memoryLimit: "768m",
    cpuLimit: 1.5,
    pidsLimit: 128,
  });
});

test("sandbox configuration rejects unsafe image and resource values", () => {
  for (const environment of [
    { GUILLERMO_DOCKER_IMAGE: "--privileged" },
    { GUILLERMO_DOCKER_IMAGE: "worker image" },
    { GUILLERMO_DOCKER_MEMORY: "0g" },
    { GUILLERMO_DOCKER_MEMORY: "32m" },
    { GUILLERMO_DOCKER_MEMORY: "65g" },
    { GUILLERMO_DOCKER_MEMORY: "unlimited" },
    { GUILLERMO_DOCKER_CPUS: "0" },
    { GUILLERMO_DOCKER_CPUS: "65" },
    { GUILLERMO_DOCKER_PIDS: "15" },
    { GUILLERMO_DOCKER_PIDS: "2.5" },
  ]) {
    assert.throws(() => loadSandboxConfig(environment), /GUILLERMO_DOCKER_/);
  }
});
