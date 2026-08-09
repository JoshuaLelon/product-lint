import type { Diagnostic } from "./types.js";
import { annotateDiagnostic } from "./remediation.js";

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
  if (diagnostic.command) lines.push(`  run: ${diagnostic.command}`);
  return lines.join("\n");
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "Product Lint: no diagnostics.\n";
  return `${diagnostics.map(formatDiagnostic).join("\n\n")}\n`;
}
