import { z } from "zod";
import { isSafeBranchName, parseRepositorySlug, type RepositoryTarget } from "../../application/repository-target.js";
import { ProjectKeySchema } from "./jira-schemas.js";

const MAX_PR_TITLE_FORMAT_LENGTH = 200;

const JiraProjectMapSchema = z.record(z.string(), z.unknown());
const JiraProjectCandidateSchema = z.looseObject({
  repository: z.unknown(),
  baseBranch: z.unknown(),
  prTitleFormat: z.unknown().optional(),
});
const JiraProjectConfigSchema = z.object({
  repository: z.custom<RepositoryTarget>(),
  baseBranch: z.string().refine(isSafeBranchName),
  prTitleFormat: z.string().refine(isSafeTitleFormat).optional(),
});

export type JiraProjectConfig = z.infer<typeof JiraProjectConfigSchema>;
export type JiraProjectMap = Readonly<Record<string, JiraProjectConfig>>;

export function parseProjectMap(raw: string): JiraProjectMap {
  const value = parseJson(raw);
  const parsedMap = JiraProjectMapSchema.safeParse(value);
  if (!parsedMap.success || Object.keys(parsedMap.data).length === 0) {
    throw new Error("GUILLERMO_JIRA_PROJECTS must be a non-empty object.");
  }

  const projects: Record<string, JiraProjectConfig> = {};
  for (const [projectKey, candidate] of Object.entries(parsedMap.data)) {
    if (!ProjectKeySchema.safeParse(projectKey).success) {
      throw new Error("Each Jira project mapping needs a valid uppercase project key and object value.");
    }
    projects[projectKey] = parseProjectConfig(projectKey, candidate);
  }
  return projects;
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("GUILLERMO_JIRA_PROJECTS must be valid JSON.");
  }
}

function parseProjectConfig(projectKey: string, value: unknown): JiraProjectConfig {
  const candidate = JiraProjectCandidateSchema.safeParse(value);
  if (!candidate.success) {
    throw new Error("Each Jira project mapping needs a valid uppercase project key and object value.");
  }

  let repository: RepositoryTarget;
  try {
    if (typeof candidate.data.repository !== "string") throw new Error();
    repository = parseRepositorySlug(candidate.data.repository);
  } catch {
    throw new Error(`Jira project ${projectKey} must configure a valid GitHub repository as owner/name.`);
  }

  const baseBranch = JiraProjectConfigSchema.shape.baseBranch.safeParse(candidate.data.baseBranch);
  if (!baseBranch.success) {
    throw new Error(`Jira project ${projectKey} must configure a valid baseBranch.`);
  }

  const prTitleFormat = JiraProjectConfigSchema.shape.prTitleFormat.safeParse(candidate.data.prTitleFormat);
  if (!prTitleFormat.success) {
    throw new Error(`Jira project ${projectKey} has an invalid prTitleFormat.`);
  }

  return {
    repository,
    baseBranch: baseBranch.data,
    ...(prTitleFormat.data === undefined ? {} : { prTitleFormat: prTitleFormat.data }),
  };
}

function isSafeTitleFormat(value: string): boolean {
  const literalText = value.replaceAll("{issueKey}", "").replaceAll("{summary}", "");
  return value.trim().length > 0 && value.length <= MAX_PR_TITLE_FORMAT_LENGTH
    && !literalText.includes("{") && !literalText.includes("}");
}
