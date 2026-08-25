import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  GitHubAppTokenProvider,
  GitHubRestApi,
  type HttpClient,
  type HttpRequest,
} from "../../src/integrations/github/github-app.js";

test("GitHub App authentication requests least-privilege installation tokens and refreshes near expiration", async () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  let now = new Date("2026-01-01T00:00:00Z");
  const requests: HttpRequest[] = [];
  const responses = [
    { token: "first-token", expires_at: "2026-01-01T00:05:00Z" },
    { token: "second-token", expires_at: "2026-01-01T01:00:00Z" },
  ];
  const http: HttpClient = { request: async (request) => {
    requests.push(request);
    return { status: 201, body: JSON.stringify(responses.shift()) };
  } };
  const provider = new GitHubAppTokenProvider({ appId: "123", installationId: "456", privateKeyPath: "/key.pem" }, {
    http,
    readPrivateKey: async () => pem,
    now: () => now,
  });

  assert.equal((await provider.getToken()).value, "first-token");
  assert.equal((await provider.getToken()).value, "first-token");
  assert.equal(requests.length, 1);
  now = new Date("2026-01-01T00:04:30Z");
  assert.equal((await provider.getToken()).value, "second-token");
  assert.equal(requests.length, 2);
  assert.equal(requests[0]?.url, "https://api.github.com/app/installations/456/access_tokens");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), { permissions: { contents: "write", pull_requests: "write" } });
  assert.match(requests[0]?.headers.Authorization ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
  assert.doesNotMatch(JSON.stringify(requests), /first-token|second-token|PRIVATE KEY/);
});

test("GitHub REST API creates pull requests with installation authentication", async () => {
  const requests: HttpRequest[] = [];
  const http: HttpClient = { request: async (request) => {
    requests.push(request);
    return { status: 201, body: JSON.stringify({ html_url: "https://github.com/my-org/app/pull/42" }) };
  } };
  const api = new GitHubRestApi({
    getToken: async () => ({ value: "installation-token", expiresAt: new Date("2030-01-01T00:00:00Z") }),
  }, http);
  const url = await api.createPullRequest({
    repository: { owner: "my-org", name: "app" },
    title: "[APP-42] Fix it",
    body: "Created safely",
    head: "guillermo/app-42",
    base: "main",
  });

  assert.equal(url, "https://github.com/my-org/app/pull/42");
  assert.equal(requests[0]?.url, "https://api.github.com/repos/my-org/app/pulls");
  assert.equal(requests[0]?.headers.Authorization, "Bearer installation-token");
  assert.deepEqual(JSON.parse(requests[0]?.body ?? ""), {
    title: "[APP-42] Fix it", body: "Created safely", head: "guillermo/app-42", base: "main",
  });
});

test("GitHub failures do not include response bodies or installation tokens", async () => {
  const api = new GitHubRestApi({
    getToken: async () => ({ value: "installation-token", expiresAt: new Date("2030-01-01T00:00:00Z") }),
  }, { request: async () => ({ status: 403, body: "server echoed installation-token" }) });
  await assert.rejects(api.createPullRequest({
    repository: { owner: "my-org", name: "app" }, title: "title", body: "body", head: "head", base: "main",
  }), (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, /HTTP 403/);
    assert.doesNotMatch(message, /installation-token|server echoed/);
    return true;
  });
});
