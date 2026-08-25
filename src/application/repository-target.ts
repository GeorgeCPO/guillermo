export interface RepositoryTarget {
  owner: string;
  name: string;
}

const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9_-])?$/;

export function parseRepositorySlug(value: string): RepositoryTarget {
  const parts = value.split("/");
  if (parts.length !== 2 || !isValidRepositoryOwner(parts[0] ?? "") || !isValidRepositoryName(parts[1] ?? "")) {
    throw new Error("Repository must use the trusted GitHub owner/name format.");
  }
  return { owner: parts[0]!, name: parts[1]! };
}

export function isValidRepositoryOwner(value: string): boolean {
  return GITHUB_OWNER.test(value) && !value.includes("--");
}

export function isValidRepositoryName(value: string): boolean {
  return GITHUB_REPOSITORY.test(value) && value !== "." && value !== ".." && !value.toLowerCase().endsWith(".git");
}

export function repositoryIdentity(target: RepositoryTarget): string {
  return `github.com/${target.owner.toLowerCase()}/${target.name.toLowerCase()}`;
}

export function repositoryHttpsUrl(target: RepositoryTarget): string {
  return `https://github.com/${target.owner}/${target.name}.git`;
}

export function isSafeBranchName(value: string): boolean {
  return value.length > 0 && value.length <= 200 && !value.startsWith("-") && !value.startsWith(".") && !value.endsWith(".")
    && !value.includes("..") && !value.includes("@{") && !/[\s~^:?*[\\]/.test(value) && !value.endsWith(".lock");
}
