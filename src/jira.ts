import path from "node:path";
import { deriveDefaultBranchName } from "./branch.js";

export interface JiraProjectConfig {
  repositoryPath: string;
  baseBranch: string;
  prTitleFormat?: string;
}

export type JiraProjectMap = Readonly<Record<string, JiraProjectConfig>>;

export interface JiraJob {
  eventId: string;
  issueKey: string;
  projectKey: string;
  repositoryPath: string;
  baseBranch: string;
  branch: string;
  task: string;
  prTitle?: string;
}

export type JiraParseResult =
  | { kind: "accepted"; job: JiraJob }
  | { kind: "ignored"; reason: string }
  | { kind: "invalid"; reason: string };

export function parseProjectMap(raw: string): JiraProjectMap {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("GUILLERMO_JIRA_PROJECTS must be valid JSON.");
  }
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error("GUILLERMO_JIRA_PROJECTS must be a non-empty object.");
  }

  const projects: Record<string, JiraProjectConfig> = {};
  for (const [projectKey, candidate] of Object.entries(value)) {
    if (!isProjectKey(projectKey) || !isRecord(candidate)) {
      throw new Error("Each Jira project mapping needs a valid uppercase project key and object value.");
    }
    const repositoryPath = candidate.repositoryPath;
    const baseBranch = candidate.baseBranch;
    const prTitleFormat = candidate.prTitleFormat;
    if (typeof repositoryPath !== "string" || !path.isAbsolute(repositoryPath)) {
      throw new Error(`Jira project ${projectKey} must configure an absolute repositoryPath.`);
    }
    if (typeof baseBranch !== "string" || !isSafeBranch(baseBranch)) {
      throw new Error(`Jira project ${projectKey} must configure a valid baseBranch.`);
    }
    if (prTitleFormat !== undefined && (typeof prTitleFormat !== "string" || !isSafeTitleFormat(prTitleFormat))) {
      throw new Error(`Jira project ${projectKey} has an invalid prTitleFormat.`);
    }
    projects[projectKey] = { repositoryPath: path.resolve(repositoryPath), baseBranch, prTitleFormat };
  }
  return projects;
}

export function parseJiraWebhook(payload: unknown, projects: JiraProjectMap): JiraParseResult {
  if (!isRecord(payload)) return { kind: "invalid", reason: "payload_not_object" };
  if (payload.webhookEvent !== "comment_created") return { kind: "ignored", reason: "event_not_comment_created" };
  if (!isRecord(payload.issue) || !isRecord(payload.issue.fields) || !isRecord(payload.comment)) {
    return { kind: "invalid", reason: "missing_issue_or_comment" };
  }

  const issueKey = payload.issue.key;
  const fields = payload.issue.fields;
  const summary = fields.summary;
  const commentId = payload.comment.id;
  const projectKey = isRecord(fields.project) ? fields.project.key : undefined;
  if (typeof issueKey !== "string" || !isIssueKey(issueKey)
    || typeof projectKey !== "string" || !isProjectKey(projectKey)
    || !issueKey.startsWith(`${projectKey}-`)
    || typeof summary !== "string" || !summary.trim()
    || !isJiraId(commentId)) {
    return { kind: "invalid", reason: "invalid_trusted_issue_fields" };
  }

  const commentText = jiraText(payload.comment.body);
  if (commentText === undefined) return { kind: "invalid", reason: "invalid_comment_body" };
  if (commentText.trim() !== "/guillermo") return { kind: "ignored", reason: "comment_command_not_present" };

  const project = projects[projectKey];
  if (!project) return { kind: "invalid", reason: "project_not_allowlisted" };
  const description = jiraText(fields.description);
  if (fields.description !== null && fields.description !== undefined && description === undefined) {
    return { kind: "invalid", reason: "invalid_description" };
  }

  const compactSummary = bounded(summary.replace(/\s+/g, " "), 500);
  const task = [
    `Implement the requested change for Jira issue ${issueKey}: ${compactSummary}`,
    description?.trim() ? `Issue description:\n${bounded(description, 10_000)}` : "Issue description: not provided.",
  ].join("\n\n");
  return {
    kind: "accepted",
    job: {
      eventId: `${issueKey}:comment:${commentId}`,
      issueKey,
      projectKey,
      repositoryPath: project.repositoryPath,
      baseBranch: project.baseBranch,
      branch: deriveDefaultBranchName(`${issueKey} comment ${commentId}`),
      task,
      prTitle: project.prTitleFormat ? formatTitle(project.prTitleFormat, issueKey, compactSummary) : undefined,
    },
  };
}

function jiraText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!isRecord(value) || value.type !== "doc" || !Array.isArray(value.content)) return undefined;
  const pieces: string[] = [];
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > 20 || !isRecord(node) || typeof node.type !== "string") return false;
    if (node.type === "text") {
      if (typeof node.text !== "string") return false;
      pieces.push(node.text);
    }
    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) return false;
      for (const child of node.content) if (!visit(child, depth + 1)) return false;
    }
    if (node.type === "paragraph" || node.type === "heading") pieces.push("\n");
    return true;
  };
  return visit(value, 0) ? pieces.join("").trim() : undefined;
}

function formatTitle(format: string, issueKey: string, summary: string): string {
  return bounded(format.replaceAll("{issueKey}", issueKey).replaceAll("{summary}", summary), 120);
}

function isSafeTitleFormat(value: string): boolean {
  return value.trim().length > 0 && value.length <= 200
    && value.replaceAll("{issueKey}", "").replaceAll("{summary}", "").includes("{") === false
    && value.replaceAll("{issueKey}", "").replaceAll("{summary}", "").includes("}") === false;
}

function isSafeBranch(value: string): boolean {
  return value.length <= 200 && !value.startsWith("-") && !value.startsWith(".") && !value.endsWith(".")
    && !value.includes("..") && !value.includes("@{") && !/[\s~^:?*[\\]/.test(value) && !value.endsWith(".lock");
}

function isIssueKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,49}-[1-9][0-9]*$/.test(value);
}

function isProjectKey(value: string): boolean {
  return /^[A-Z][A-Z0-9_]{0,49}$/.test(value);
}

function isJiraId(value: unknown): value is string | number {
  return (typeof value === "string" && /^[1-9][0-9]*$/.test(value))
    || (typeof value === "number" && Number.isSafeInteger(value) && value > 0);
}

function bounded(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
