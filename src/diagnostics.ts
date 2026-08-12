import type { Diagnostic } from "./types.js";
import { annotateDiagnostic } from "./remediation.js";
import { renderTree } from "./tree.js";

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

/**
 * A newline in the text is a hard break, so a numbered list stays a list. Text
 * between breaks wraps to the terminal width.
 */
function wrap(label: string, text: string): string {
  const indent = " ".repeat(label.length + 4);
  const lines: string[] = [];
  let current = `  ${label}: `;
  for (const segment of text.split("\n")) {
    for (const word of segment.split(" ")) {
      if (current.trim().length > 0 && current.length + word.length > 96) {
        lines.push(current.trimEnd());
        current = indent;
      }
      current += `${word} `;
    }
    lines.push(current.trimEnd());
    current = indent;
  }
  return lines.filter((line) => line.trim().length > 0).join("\n");
}

export function formatDiagnostic(input: Diagnostic): string {
  const diagnostic = annotateDiagnostic(input);
  const lines = [`${diagnostic.code} ${diagnostic.message}`];
  if (diagnostic.path) lines.push(`  path: ${diagnostic.path}`);
  if (diagnostic.nodeId) lines.push(`  node: ${diagnostic.nodeId}`);
  if (diagnostic.frontier) lines.push(`  frontier: ${diagnostic.frontier}`);
  if (diagnostic.question) lines.push(wrap("question", diagnostic.question));
  if (diagnostic.expectedPath) lines.push(`  expected: ${diagnostic.expectedPath}`);
  if (diagnostic.fix) lines.push(wrap("fix", diagnostic.fix));
  if (diagnostic.ask) lines.push(wrap("ask", diagnostic.ask));
  if (diagnostic.style) lines.push(wrap("style", diagnostic.style));
  if (diagnostic.shape) lines.push(wrap("shape", diagnostic.shape));
  // Widening scope, in the order a draft gets checked: the sentence, then the
  // level it sits in, then the parent it sits under, then the words it speaks.
  if (diagnostic.placement) lines.push(wrap("placement", diagnostic.placement));
  if (diagnostic.vocabulary) lines.push(wrap("vocabulary", diagnostic.vocabulary));
  if (diagnostic.command) lines.push(`  run: ${diagnostic.command}`);
  // The shape rule says to read the level before adding to it. Printing the
  // rule without the level asks the reader to recall a set they have not seen,
  // which is how a duplicate sibling gets written: it reads correct alone, and
  // only the set shows the overlap.
  const level = diagnostic.details?.level as
    | { total: number; shown: { id: string; statement: string }[] }
    | undefined;
  if (level && level.shown.length > 0) {
    lines.push(`  ${diagnostic.requiredLevel} already has (${level.total}):`);
    for (const node of level.shown) {
      lines.push(`    ${node.id}`);
      lines.push(`      ${node.statement}`);
    }
    const hidden = level.total - level.shown.length;
    // Stated, never silent. A list that stops without saying so reads as whole.
    if (hidden > 0) lines.push(`    ... and ${hidden} more not shown`);
  }

  // The vocabulary rule says to read the terms in scope before coining a word,
  // and a rule about a set the reader cannot see is advice, not information —
  // the same reason the level prints above.
  const termsInScope = diagnostic.details?.termsInScope as
    | { total: number; shown: { id: string; level: string; name: string; definition: string }[] }
    | undefined;
  if (termsInScope && termsInScope.shown.length > 0) {
    lines.push(`  terms in scope at ${diagnostic.requiredLevel} (${termsInScope.total}):`);
    for (const term of termsInScope.shown) {
      lines.push(`    *${term.name}* — ${term.id} (${term.level})`);
      lines.push(`      ${term.definition}`);
    }
    const hiddenTerms = termsInScope.total - termsInScope.shown.length;
    if (hiddenTerms > 0) lines.push(`    ... and ${hiddenTerms} more not shown`);
  }

  // A report row that speaks for many statements names them, folded under one
  // heading per term the way a long file list folds into a tree — so a common
  // word reads as one block instead of drowning the rare findings.
  const uses = diagnostic.details?.uses as { id: string; statement: string }[] | undefined;
  if (Array.isArray(uses) && uses.length > 0) {
    lines.push(`  uses (${uses.length}):`);
    for (const use of uses) {
      lines.push(`    ${use.id}`);
      lines.push(`      ${use.statement}`);
    }
  }

  // A diagnostic that speaks for many files must name them. The tree is the
  // readable form of that list, and it is the difference between "something in
  // src is ungoverned" and knowing which directory holds the work.
  const files = diagnostic.details?.files;
  if (Array.isArray(files) && files.length > 0) {
    const tree = renderTree(files.filter((file): file is string => typeof file === "string"));
    if (tree) {
      lines.push(`  files (${files.length}):`);
      for (const line of tree.split("\n")) lines.push(`    ${line}`);
    }
  }
  return lines.join("\n");
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "Product Lint: no diagnostics.\n";
  return `${diagnostics.map(formatDiagnostic).join("\n\n")}\n`;
}
