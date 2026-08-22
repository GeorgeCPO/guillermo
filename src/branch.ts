const MAX_SLUG_LENGTH = 60;

/**
 * Produces a deterministic, Git-valid local branch name from a task description.
 */
export function deriveDefaultBranchName(task: string): string {
  const slug = task
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");

  return `guillermo/${slug || "task"}`;
}
