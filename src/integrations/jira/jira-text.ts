interface AdfNode {
  type: string;
  text?: unknown;
  content?: unknown;
}

const MAX_ADF_DEPTH = 20;

export function jiraText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  if (!isAdfNode(value) || value.type !== "doc" || !Array.isArray(value.content)) return undefined;

  const pieces: string[] = [];
  return visit(value, 0, pieces) ? pieces.join("").trim() : undefined;
}

function visit(node: unknown, depth: number, pieces: string[]): boolean {
  if (depth > MAX_ADF_DEPTH || !isAdfNode(node)) return false;

  if (node.type === "text") {
    if (typeof node.text !== "string") return false;
    pieces.push(node.text);
  }
  if (node.content !== undefined) {
    if (!Array.isArray(node.content)) return false;
    for (const child of node.content) {
      if (!visit(child, depth + 1, pieces)) return false;
    }
  }
  if (node.type === "paragraph" || node.type === "heading") pieces.push("\n");
  return true;
}

function isAdfNode(value: unknown): value is AdfNode {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && "type" in value && typeof value.type === "string";
}
