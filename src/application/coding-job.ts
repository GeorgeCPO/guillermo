export interface CodingJobSource {
  eventId: string;
  metadata: Readonly<Record<string, string>>;
}

export interface CodingJob {
  source: CodingJobSource;
  repositoryPath: string;
  baseBranch: string;
  branch: string;
  task: string;
  prTitle?: string;
}
