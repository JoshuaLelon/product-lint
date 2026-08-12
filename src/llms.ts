import type { AffectedKnowledgeResult, FileKnowledgeResult, SourceCanonicalNode } from "./types.js";
import { LEVEL_PLACEMENT, NODE_SHAPE, STATEMENT_STYLE } from "./remediation.js";

/**
 * An agent that reads this view usually goes on to change the file, which then
 * requires a new or edited statement. The style rule travels with the context.
 *
 * The shape rule travels with it for a sharper reason: this view is a SLICE of
 * the graph, so an agent working from it sees a lineage and not the level. That
 * is the exact position from which a duplicate node gets written — the node that
 * already says this is a sibling the slice never showed.
 *
 * The placement rule travels for the opposite reason, which is why both belong
 * here. A slice is exactly a lineage, so unlike the level, the parent IS on the
 * page: this is the one view where an agent can run the pair check against the
 * material in front of it rather than from memory.
 */
function styleFooter(): string[] {
  return [
    "# If you write or edit a statement",
    STATEMENT_STYLE,
    "",
    "# If you add a node",
    NODE_SHAPE,
    "",
    "# If you choose the level for a node",
    LEVEL_PLACEMENT,
    "",
  ];
}

function renderNode(node: SourceCanonicalNode): string {
  const lines = [
    `## ${node.id}`,
    `level: ${node.level}`,
    `statement: ${node.statement}`,
  ];
  if (node.constrainedBy.length > 0) lines.push(`constrainedBy: ${node.constrainedBy.join(", ")}`);
  return lines.join("\n");
}

export function renderFileKnowledgeForLlm(result: FileKnowledgeResult): string {
  // The lineage lists the audience NODES it passed through, and a wildcard is
  // not a node — so a file reached through one reads as scoped to whatever other
  // audience parent it happens to have. State the resolved answer beside it.
  const lines = ["# Product knowledge for file", `file: ${result.file}`];
  if (result.audience) lines.push(`audience: ${result.audience}`);
  lines.push("");
  for (const node of result.lineage) lines.push(renderNode(node), "");
  if (result.references.length > 0) {
    lines.push("# Relevant references", "");
    for (const reference of result.references) {
      lines.push(`## ${reference.id}`, `kind: ${reference.kind}`, `statement: ${reference.statement}`, "");
    }
  }
  lines.push(...styleFooter());
  return `${lines.join("\n").trim()}\n`;
}

export function renderAffectedKnowledgeForLlm(result: AffectedKnowledgeResult): string {
  const lines = ["# Product knowledge affected by node", renderNode(result.node)];
  if (result.audience) lines.push(`audience: ${result.audience}`);
  lines.push("");
  if (result.descendants.length > 0) {
    lines.push("# Descendant knowledge", "");
    for (const node of result.descendants) lines.push(renderNode(node), "");
  }
  if (result.files.length > 0) {
    lines.push("# Affected files", ...result.files.map((file) => `- ${file}`), "");
  }
  if (result.references.length > 0) {
    lines.push("# Relevant references", "");
    for (const reference of result.references) {
      lines.push(`## ${reference.id}`, `kind: ${reference.kind}`, `statement: ${reference.statement}`, "");
    }
  }
  lines.push(...styleFooter());
  return `${lines.join("\n").trim()}\n`;
}
