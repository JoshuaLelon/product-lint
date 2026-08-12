import type {
  AffectedKnowledgeResult,
  FileKnowledgeResult,
  SourceCanonicalNode,
  SourceTermNode,
} from "./types.js";
import { LEVEL_PLACEMENT, NODE_SHAPE, STATEMENT_STYLE, VOCABULARY_RULE } from "./remediation.js";
import { buildVocabulary, resolveMarks } from "./terms.js";

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
    "# If you use or coin a term",
    VOCABULARY_RULE,
    "",
  ];
}

/**
 * The definitions of every term the shown statements mark. An agent editing
 * from this view meets *rung* with its meaning on the page it is editing from,
 * rather than coined somewhere it has never read.
 */
function termsSection(nodes: SourceCanonicalNode[], terms: SourceTermNode[]): string[] {
  if (terms.length === 0) return [];
  const vocabulary = buildVocabulary(terms);
  const used = new Map<string, SourceTermNode>();
  for (const node of nodes) {
    for (const term of resolveMarks(node.statement, vocabulary).terms) used.set(term.id, term);
  }
  // Definitions may mark terms of their own; those meanings belong on the page too.
  for (const term of [...used.values()]) {
    for (const inner of resolveMarks(term.definition, vocabulary).terms) used.set(inner.id, inner);
  }
  if (used.size === 0) return [];
  const lines = ["# Terms", ""];
  for (const term of [...used.values()].sort((left, right) => left.id.localeCompare(right.id))) {
    lines.push(`## ${term.id}`, `level: ${term.level}`, `name: ${term.name}`, `definition: ${term.definition}`, "");
  }
  return lines;
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

export function renderFileKnowledgeForLlm(
  result: FileKnowledgeResult,
  terms: SourceTermNode[] = [],
): string {
  // The lineage lists the audience NODES it passed through, and a wildcard is
  // not a node — so a file reached through one reads as scoped to whatever other
  // audience parent it happens to have. State the resolved answer beside it.
  const lines = ["# Product knowledge for file", `file: ${result.file}`];
  if (result.audience) lines.push(`audience: ${result.audience}`);
  lines.push("");
  for (const node of result.lineage) lines.push(renderNode(node), "");
  lines.push(...termsSection(result.lineage, terms));
  if (result.references.length > 0) {
    lines.push("# Relevant references", "");
    for (const reference of result.references) {
      lines.push(`## ${reference.id}`, `kind: ${reference.kind}`, `statement: ${reference.statement}`, "");
    }
  }
  lines.push(...styleFooter());
  return `${lines.join("\n").trim()}\n`;
}

export function renderAffectedKnowledgeForLlm(
  result: AffectedKnowledgeResult,
  terms: SourceTermNode[] = [],
): string {
  const lines = ["# Product knowledge affected by node", renderNode(result.node)];
  if (result.audience) lines.push(`audience: ${result.audience}`);
  lines.push("");
  if (result.descendants.length > 0) {
    lines.push("# Descendant knowledge", "");
    for (const node of result.descendants) lines.push(renderNode(node), "");
  }
  lines.push(...termsSection([result.node, ...result.descendants], terms));
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
