import type { GuillermoConfig } from "../config/config.js";
import type { GitCommitAuthor } from "../config/webhook-config.js";
import type { PullRequestApi } from "../integrations/github/github-app.js";
import { createRemotePullRequest } from "../integrations/github/pull-request.js";
import { ProcessGitClient } from "../infrastructure/git/git-client.js";
import type { CodingJob } from "./coding-job.js";
import type { ManagedWorkspace, ManagedWorkspaceProvider } from "./managed-workspace.js";
import { prepareRepository } from "./repository-preparation.js";
import { runGuillermo, type GuillermoRunResult, type RunGuillermoDependencies } from "./run.js";

export interface RemoteJobDependencies {
  workspaces: Pick<ManagedWorkspaceProvider, "withWorkspace">;
  prepare(root: string): Promise<void>;
  run(
    config: GuillermoConfig,
    options: Parameters<typeof runGuillermo>[1],
    overrides?: Partial<RunGuillermoDependencies>,
  ): Promise<GuillermoRunResult>;
}

export async function runRemoteJob(
  config: GuillermoConfig,
  job: CodingJob,
  commitAuthor: GitCommitAuthor,
  api: PullRequestApi,
  workspaces: Pick<ManagedWorkspaceProvider, "withWorkspace">,
  overrides: Partial<Omit<RemoteJobDependencies, "workspaces">> = {},
): Promise<GuillermoRunResult> {
  const dependencies: RemoteJobDependencies = {
    workspaces,
    prepare: prepareRepository,
    run: runGuillermo,
    ...overrides,
  };
  return dependencies.workspaces.withWorkspace(job.repository, job.baseBranch, async (workspace: ManagedWorkspace) => {
    await dependencies.prepare(workspace.root);
    return dependencies.run(config, {
      repo: workspace.root,
      task: job.task,
      branch: job.branch,
      branchStartPoint: job.baseBranch,
      baseBranch: job.baseBranch,
      prTitle: job.prTitle,
    }, {
      createPullRequest: (report, options) => createRemotePullRequest(report, {
        ...options,
        repository: job.repository,
        commitAuthor,
      }, workspace.authentication, api, new ProcessGitClient()),
    });
  });
}
