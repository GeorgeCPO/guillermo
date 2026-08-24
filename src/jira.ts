import { deriveDefaultBranchName } from "./branch.js";
import type { JiraProjectMap } from "./jira-config.js";
import { JiraEnvelopeSchema, JiraPayloadObjectSchema, TrustedIssueFieldsSchema } from "./jira-schemas.js";
import { jiraText } from "./jira-text.js";

export { parseProjectMap } from "./jira-config.js";
export type { JiraProjectConfig, JiraProjectMap } from "./jira-config.js";

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

export function parseJiraWebhook(payload: unknown, projects: JiraProjectMap): JiraParseResult {
  const payloadObject = JiraPayloadObjectSchema.safeParse(payload);
  if (!payloadObject.success) return { kind: "invalid", reason: "payload_not_object" };

  // Only comment creation events are eligible to trigger work.
  if (payloadObject.data.webhookEvent !== "comment_created") {
    return { kind: "ignored", reason: "event_not_comment_created" };
  }

  const envelope = JiraEnvelopeSchema.safeParse(payloadObject.data);
  if (!envelope.success) return { kind: "invalid", reason: "missing_issue_or_comment" };

  const trusted = TrustedIssueFieldsSchema.safeParse(envelope.data);
  if (!trusted.success) return { kind: "invalid", reason: "invalid_trusted_issue_fields" };

  const { issue, comment } = trusted.data;
  const { key: issueKey, fields } = issue;
  const { key: projectKey } = fields.project;

  // Jira's issue key and nested project key must identify the same project.
  if (!issueKey.startsWith(`${projectKey}-`)) {
    return { kind: "invalid", reason: "invalid_trusted_issue_fields" };
  }

  const commentText = jiraText(comment.body);
  if (commentText === undefined) return { kind: "invalid", reason: "invalid_comment_body" };

  // No surrounding prose or additional commands are accepted.
  if (commentText.trim() !== "/guillermo") {
    return { kind: "ignored", reason: "comment_command_not_present" };
  }

  // Repository and branch settings come only from the server-owned project map.
  const project = projects[projectKey];
  if (!project) return { kind: "invalid", reason: "project_not_allowlisted" };

  const description = jiraText(fields.description);
  if (fields.description !== null && fields.description !== undefined && description === undefined) {
    return { kind: "invalid", reason: "invalid_description" };
  }

  const summary = bounded(fields.summary.replace(/\s+/g, " "), 500);
  return {
    kind: "accepted",
    job: {
      eventId: `${issueKey}:comment:${comment.id}`,
      issueKey,
      projectKey,
      repositoryPath: project.repositoryPath,
      baseBranch: project.baseBranch,
      branch: deriveDefaultBranchName(`${issueKey} comment ${comment.id}`),
      task: buildTask(issueKey, summary, description),
      prTitle: project.prTitleFormat ? formatTitle(project.prTitleFormat, issueKey, summary) : undefined,
    },
  };
}

function buildTask(issueKey: string, summary: string, description: string | undefined): string {
  return [
    `Implement the requested change for Jira issue ${issueKey}: ${summary}`,
    description?.trim() ? `Issue description:\n${bounded(description, 10_000)}` : "Issue description: not provided.",
  ].join("\n\n");
}

function formatTitle(format: string, issueKey: string, summary: string): string {
  return bounded(format.replaceAll("{issueKey}", issueKey).replaceAll("{summary}", summary), 120);
}

function bounded(value: string, maxLength: number): string {
  const normalized = value.replace(/\r\n?/g, "\n").trim();
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}
