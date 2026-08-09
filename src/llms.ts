import type { AffectedKnowledgeResult, FileKnowledgeResult, SourceCanonicalNode } from "./types.js";

function renderNode(node: SourceCanonicalNode): string {
  const lines = [
    `## ${node.id}`,
    `level: ${node.level}`,
    `kind: ${node.kind}`,
    `statement: ${node.statement}`,
  ];
  if (node.constrainedBy.length > 0) lines.push(`constrainedBy: ${node.constrainedBy.join(", ")}`);
  return lines.join("\n");
}

export function renderFileKnowledgeForLlm(result: FileKnowledgeResult): string {
  const lines = ["# Product knowledge for file", `file: ${result.file}`, ""];
  for (const node of result.lineage) lines.push(renderNode(node), "");
  if (result.references.length > 0) {
    lines.push("# Relevant references", "");
    for (const reference of result.references) {
      lines.push(`## ${reference.id}`, `kind: ${reference.kind}`, `statement: ${reference.statement}`, "");
    }
  }
  return `${lines.join("\n").trim()}\n`;
}

export function renderAffectedKnowledgeForLlm(result: AffectedKnowledgeResult): string {
  const lines = ["# Product knowledge affected by node", renderNode(result.node), ""];
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
  return `${lines.join("\n").trim()}\n`;
}
