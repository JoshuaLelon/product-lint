import type { Diagnostic } from "./types.js";

export function hasErrors(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((diagnostic) => diagnostic.severity === "error");
}

export function formatDiagnostic(diagnostic: Diagnostic): string {
  const lines = [`${diagnostic.code} ${diagnostic.message}`];
  if (diagnostic.path) lines.push(`  path: ${diagnostic.path}`);
  if (diagnostic.nodeId) lines.push(`  node: ${diagnostic.nodeId}`);
  if (diagnostic.frontier) lines.push(`  frontier: ${diagnostic.frontier}`);
  if (diagnostic.question) lines.push(`  question: ${diagnostic.question}`);
  if (diagnostic.expectedPath) lines.push(`  expected: ${diagnostic.expectedPath}`);
  if (diagnostic.command) lines.push(`  run: ${diagnostic.command}`);
  return lines.join("\n");
}

export function formatDiagnostics(diagnostics: Diagnostic[]): string {
  if (diagnostics.length === 0) return "Product Lint: no diagnostics.\n";
  return `${diagnostics.map(formatDiagnostic).join("\n\n")}\n`;
}
