import type { GuillermoRunResult } from "./run.js";
import type {
  PullRequestFailureReasonCode,
  PullRequestSkipReasonCode,
} from "../integrations/github/pull-request.js";

export type JobOutcome = "created" | "skipped" | "failed";

interface JobExecutionCounts {
  agentTermination: GuillermoRunResult["report"]["termination"];
  agentStepCount: number;
  changedFileCount: number;
  testRunCount: number;
  successfulTestRunCount: number;
}

export type JobExecutionResult = JobExecutionCounts & (
  | { outcome: "created" }
  | { outcome: "skipped"; reasonCode: PullRequestSkipReasonCode }
  | { outcome: "failed"; reasonCode: PullRequestFailureReasonCode }
);

/**
 * Converts the detailed run report into the only fields permitted in production
 * lifecycle logs. Keep repository-controlled strings out of this boundary.
 */
export function summarizeJobExecution(result: GuillermoRunResult): JobExecutionResult {
  const counts: JobExecutionCounts = {
    agentTermination: result.report.termination,
    agentStepCount: result.report.stepsUsed,
    changedFileCount: result.report.changedFiles.length,
    testRunCount: result.report.testRuns.length,
    successfulTestRunCount: result.report.testRuns.filter(({ result: testResult }) => testResult.exitCode === 0).length,
  };

  if (result.pullRequest.status === "created") return { ...counts, outcome: "created" };
  if (result.pullRequest.status === "skipped") {
    return {
      ...counts,
      outcome: "skipped",
      reasonCode: result.pullRequest.reasonCode,
    };
  }
  return {
    ...counts,
    outcome: "failed",
    reasonCode: result.pullRequest.reasonCode,
  };
}
