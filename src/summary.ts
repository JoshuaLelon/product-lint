import type {
  Diagnostic,
  DiagnosticSeverity,
  KnowledgeGraph,
  KnowledgeLevel,
  ScopeSummary,
} from "./types.js";
import { levelIndex } from "./terms.js";

/**
 * One screen that says what to do next.
 *
 * The full diagnostic blocks are right — each one carries its repair, its
 * question, and the set it refers to — and they are the wrong thing to open
 * with. A single `PL0201` prints its question, its fix, the asking formats, the
 * statement style, the shape rule, the vocabulary rule, and twenty sibling
 * nodes; on a real repository the first fifteen lines of `check` are one
 * finding's remediation prose and nothing else. Since a reader — human or agent
 * — heads the output anyway, the first fifteen lines have to be the whole
 * picture, and `--full` is one flag away.
 *
 * Ordering is severity, then level. Severity first because an invalid graph is
 * not an incomplete one, and reading shape findings off a graph that does not
 * parse is reading noise — the same rank `applyStatusExitCode` already uses.
 * Level second because a problem decides what everything beneath it is even
 * for, so the same finding is worth more the shallower it sits.
 */
export interface SummaryRow {
  severity: DiagnosticSeverity;
  level?: KnowledgeLevel;
  label: string;
  count: number;
  /** The first subject, so a row is actionable without expanding it. */
  exemplar?: string;
  command?: string;
}

export interface SummaryInput {
  diagnostics: Diagnostic[];
  graph?: KnowledgeGraph;
  scope?: ScopeSummary;
  ignored?: { smell: string; nodeId?: string; because: string }[];
  /** Rows to print before folding the rest into one line. */
  limit?: number;
}

const SEVERITY_RANK: Record<DiagnosticSeverity, number> = { error: 0, warning: 1, info: 2 };

/** `PL0901 DRAFT_NODE` reads as `draft-node`. Derived, so a new code needs no table entry. */
export function labelFor(code: string): string {
  const name = code.split(" ")[1] ?? code;
  return name.toLowerCase().replaceAll("_", "-");
}

function levelOf(diagnostic: Diagnostic, graph?: KnowledgeGraph): KnowledgeLevel | undefined {
  // requiredLevel is the level of the WORK, which is what a reader orders by:
  // PL0201 on a product node is a behavior node to write. Falling back to the
  // subject's own level covers the findings that are about a node rather than
  // about a gap beneath it.
  if (diagnostic.requiredLevel && diagnostic.requiredLevel !== "implementation") {
    return diagnostic.requiredLevel;
  }
  const id = diagnostic.nodeId ?? diagnostic.frontier;
  return id ? graph?.nodes.get(id)?.level : undefined;
}

/**
 * `PL0901` already carries its per-level split, and it is the one diagnostic
 * that speaks for several levels at once. Folding it into a single row would
 * hide the only ordering that matters for it — sixteen drafts are not one job,
 * they are a context job and then a product job.
 */
function expand(
  diagnostic: Diagnostic,
  graph?: KnowledgeGraph,
): { level?: KnowledgeLevel; count: number; exemplar?: string }[] {
  const drafts = diagnostic.details?.drafts as
    | { level: KnowledgeLevel; ids: string[] }[]
    | undefined;
  if (Array.isArray(drafts) && drafts.length > 0) {
    return drafts.map((group) => ({
      level: group.level,
      count: group.ids.length,
      exemplar: group.ids[0],
    }));
  }
  const files = diagnostic.details?.files;
  const count = Array.isArray(files) && files.length > 0 ? files.length : 1;
  const exemplar =
    diagnostic.nodeId ??
    diagnostic.frontier ??
    diagnostic.path ??
    (Array.isArray(files) ? (files[0] as string) : undefined);
  return [{ level: levelOf(diagnostic, graph), count, ...(exemplar ? { exemplar } : {}) }];
}

export function summaryRows(diagnostics: Diagnostic[], graph?: KnowledgeGraph): SummaryRow[] {
  const rows = new Map<string, SummaryRow>();
  for (const diagnostic of diagnostics) {
    const label = labelFor(diagnostic.code);
    for (const part of expand(diagnostic, graph)) {
      const key = `${diagnostic.severity}|${part.level ?? ""}|${label}`;
      const existing = rows.get(key);
      if (existing) {
        existing.count += part.count;
        continue;
      }
      rows.set(key, {
        severity: diagnostic.severity,
        ...(part.level ? { level: part.level } : {}),
        label,
        count: part.count,
        ...(part.exemplar ? { exemplar: part.exemplar } : {}),
        ...(diagnostic.command ? { command: diagnostic.command } : {}),
      });
    }
  }
  return [...rows.values()].sort(
    (left, right) =>
      SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] ||
      // A finding with no level is about the repository rather than a layer, so
      // it sorts after the layers rather than pretending to be the shallowest.
      (left.level ? levelIndex(left.level) : Number.MAX_SAFE_INTEGER) -
        (right.level ? levelIndex(right.level) : Number.MAX_SAFE_INTEGER) ||
      left.label.localeCompare(right.label),
  );
}

const DEFAULT_LIMIT = 10;

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

export function renderSummary(input: SummaryInput): string {
  const rows = summaryRows(input.diagnostics, input.graph);
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const lines: string[] = [];

  if (total === 0) {
    lines.push("no findings.");
  } else {
    lines.push(`${total} finding(s) — errors first, then shallowest level, the order of leverage`);
    lines.push("");
    const limit = input.limit ?? DEFAULT_LIMIT;
    const shown = rows.slice(0, limit);
    const levelWidth = Math.max(...shown.map((row) => (row.level ?? "").length), 8);
    const labelWidth = Math.max(...shown.map((row) => row.label.length), 12);
    for (const row of shown) {
      const marker = row.severity === "error" ? "!" : row.severity === "warning" ? "~" : " ";
      const subject = row.exemplar ? ` ${row.exemplar}` : "";
      lines.push(
        `  ${marker} ${pad(row.level ?? "", levelWidth)}  ${pad(row.label, labelWidth)}  ${String(row.count).padStart(3)}${subject}`,
      );
    }
    // Stated, never silent: a list that stops without saying so reads as whole.
    const hidden = rows.slice(limit).reduce((sum, row) => sum + row.count, 0);
    if (hidden > 0) {
      lines.push(`  ${pad("", 4 + levelWidth)}  ${pad("... and more", labelWidth)}  ${String(hidden).padStart(3)}`);
    }
  }

  // What was held back, and why. A scoped report is a quieter report, and quiet
  // is exactly what a finished repository looks like.
  if (input.scope) {
    const shared =
      input.scope.contested > 0 ? `, ${input.scope.contested} shared with them` : "";
    lines.push("");
    lines.push(
      `  scope: ${input.scope.roots.length} of ${input.scope.roots.length + input.scope.deferredRoots.length} problems — ${input.scope.deferred} finding(s) deferred${shared}`,
    );
    lines.push(`  because: ${input.scope.because}`);
  }
  for (const entry of input.ignored ?? []) {
    lines.push(
      `  ignored: ${entry.smell}${entry.nodeId ? ` on ${entry.nodeId}` : ""} — ${entry.because}`,
    );
  }

  if (total > 0) {
    lines.push("");
    lines.push("  product-lint check --full     every finding with its repair");
    if (input.scope) lines.push("  product-lint check --all      include the deferred problems");
  }
  return `${lines.join("\n")}\n`;
}
