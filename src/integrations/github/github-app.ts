import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { GitHubAppConfig } from "../../config/webhook-config.js";
import type { RepositoryTarget } from "../../application/repository-target.js";

const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const HTTP_TIMEOUT_MS = 30_000;
const TOKEN_REFRESH_WINDOW_MS = 60_000;

export interface HttpRequest {
  method: "GET" | "POST";
  url: string;
  headers: Readonly<Record<string, string>>;
  body?: string;
  timeoutMs: number;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface HttpClient {
  request(request: HttpRequest): Promise<HttpResponse>;
}

export class FetchHttpClient implements HttpClient {
  async request(request: HttpRequest): Promise<HttpResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: request.body,
        signal: controller.signal,
      });
      return { status: response.status, body: await response.text() };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("GitHub API request timed out.");
      throw new Error(`GitHub API request failed: ${error instanceof Error ? error.name : "UnknownError"}.`);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export interface InstallationToken {
  value: string;
  expiresAt: Date;
}

export interface InstallationTokenProvider {
  getToken(): Promise<InstallationToken>;
}

export interface GitHubAppTokenProviderDependencies {
  http: HttpClient;
  readPrivateKey(path: string): Promise<string>;
  now(): Date;
}

export class GitHubAppTokenProvider implements InstallationTokenProvider {
  private cached?: InstallationToken;

  public constructor(
    private readonly config: GitHubAppConfig,
    private readonly dependencies: GitHubAppTokenProviderDependencies = {
      http: new FetchHttpClient(),
      readPrivateKey: (file) => readFile(file, "utf8"),
      now: () => new Date(),
    },
  ) {}

  async getToken(): Promise<InstallationToken> {
    const now = this.dependencies.now();
    if (this.cached && this.cached.expiresAt.getTime() - now.getTime() > TOKEN_REFRESH_WINDOW_MS) return this.cached;

    const privateKey = await this.dependencies.readPrivateKey(this.config.privateKeyPath);
    const jwt = createAppJwt(this.config.appId, privateKey, now);
    const response = await this.dependencies.http.request({
      method: "POST",
      url: `${GITHUB_API}/app/installations/${this.config.installationId}/access_tokens`,
      headers: githubHeaders(`Bearer ${jwt}`),
      body: JSON.stringify({ permissions: { contents: "write", pull_requests: "write" } }),
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub App token request failed with HTTP ${response.status}.`);
    }

    const parsed = parseJson(response.body);
    if (!isObject(parsed) || typeof parsed.token !== "string" || parsed.token.length === 0
      || typeof parsed.expires_at !== "string" || !Number.isFinite(Date.parse(parsed.expires_at))) {
      throw new Error("GitHub App token response was invalid.");
    }
    this.cached = { value: parsed.token, expiresAt: new Date(parsed.expires_at) };
    return this.cached;
  }
}

export interface PullRequestApi {
  createPullRequest(input: {
    repository: RepositoryTarget;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string>;
}

export class GitHubRestApi implements PullRequestApi {
  public constructor(
    private readonly tokens: InstallationTokenProvider,
    private readonly http: HttpClient = new FetchHttpClient(),
  ) {}

  async createPullRequest(input: {
    repository: RepositoryTarget;
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<string> {
    const token = await this.tokens.getToken();
    const response = await this.http.request({
      method: "POST",
      url: `${GITHUB_API}/repos/${encodeURIComponent(input.repository.owner)}/${encodeURIComponent(input.repository.name)}/pulls`,
      headers: githubHeaders(`Bearer ${token.value}`),
      body: JSON.stringify({ title: input.title, body: input.body, head: input.head, base: input.base }),
      timeoutMs: HTTP_TIMEOUT_MS,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub pull-request creation failed with HTTP ${response.status}.`);
    }
    const parsed = parseJson(response.body);
    if (!isObject(parsed) || typeof parsed.html_url !== "string" || !parsed.html_url.startsWith("https://github.com/")) {
      throw new Error("GitHub pull-request response did not contain a valid URL.");
    }
    return parsed.html_url;
  }
}

export function createAppJwt(appId: string, privateKey: string, now: Date): string {
  const issuedAt = Math.floor(now.getTime() / 1_000) - 60;
  const encodedHeader = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const encodedPayload = base64Url(JSON.stringify({ iat: issuedAt, exp: issuedAt + 9 * 60, iss: appId }));
  const content = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(content);
  signer.end();
  return `${content}.${signer.sign(privateKey, "base64url")}`;
}

function githubHeaders(authorization: string): Record<string, string> {
  return {
    Accept: "application/vnd.github+json",
    Authorization: authorization,
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": API_VERSION,
    "User-Agent": "guillermo",
  };
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error("GitHub API returned invalid JSON.");
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
