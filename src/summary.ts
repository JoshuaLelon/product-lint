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

/**
 * The commit seam has two messages, and they must not blend.
 *
 * When the commit is refused, the only relevant information is why and how to
 * proceed. Appending "here is what you could work on next" to a refusal is noise
 * at the worst possible moment: someone is being stopped, and a list of
 * unrelated opportunities buries the one thing they have to read.
 *
 * When it passes, the opposite: the commit is the one moment the tool is
 * guaranteed to have their attention, and spending it on silence is the whole
 * reason a repository drifts. Today a clean commit prints nothing.
 */
/**
 * Refusals rank by CAUSE, not by level.
 *
 * The summary sorts by severity then level, and neither works here: every entry
 * in a refusal is an error, and the level a node sits at says nothing about
 * whether it is worth fixing first. What ranks them is what fixing one makes
 * knowable. A file that does not parse contributes no node, so the graph built
 * without it is missing parents that exist on disk; a graph that does not build
 * has no lineage, so every digest computed over it is meaningless. Tiers below a
 * broken tier are not "also wrong" — they are unknown, and several of them
 * routinely vanish when the tier above is repaired.
 *
 * Ordered, and first match wins.
 */
const REFUSAL_TIERS: { name: string; test: (code: string) => boolean }[] = [
  {
    name: "the files do not parse",
    test: (code) => /^PL1[02]/.test(code) || /^PL130[1-6]/.test(code),
  },
  {
    name: "the graph does not build",
    test: (code) => /^PL11/.test(code) || code.startsWith("PL1310"),
  },
  { name: "words do not resolve", test: (code) => /^PL13(0[78]|1[12])/.test(code) },
  { name: "derived data is stale", test: (code) => /^PL20/.test(code) },
  { name: "this commit is inconsistent with itself", test: (code) => /^PL21/.test(code) },
  { name: "the configuration names something absent", test: (code) => /^PL14/.test(code) },
  { name: "other", test: () => true },
];

function subjectOf(diagnostic: Diagnostic): string | undefined {
  return (
    diagnostic.nodeId ??
    (diagnostic.path && !diagnostic.path.endsWith(".json") ? diagnostic.path : undefined) ??
    (diagnostic.details?.files as string[] | undefined)?.[0] ??
    diagnostic.path
  );
}

/**
 * The context an agent needs before it can fix anything, derived from the
 * subjects rather than guessed at. This is the difference between "a node is
 * stale" and knowing which file to open.
 */
function contextCommands(errors: Diagnostic[]): string[] {
  const commands: string[] = [];
  for (const diagnostic of errors) {
    if (diagnostic.nodeId) {
      commands.push(`product-lint llms affected-by ${diagnostic.nodeId}`);
      continue;
    }
    const file =
      diagnostic.path && !diagnostic.path.endsWith(".json")
        ? diagnostic.path
        : (diagnostic.details?.files as string[] | undefined)?.[0];
    if (file) {
      commands.push(`product-lint llms for-file ${file}`);
      continue;
    }
    // An error naming a level rather than a subject is a frontier question
    // wearing a refusal, and the frontier is where its answer lives.
    if (diagnostic.requiredLevel) commands.push("product-lint frontier");
  }
  return [...new Set(commands)];
}

/**
 * Inside a tier, two collapses, and which applies depends on the shape:
 *
 * - Many subjects sharing one repair is ONE line. Twelve stale nodes and one
 *   `knowledge sync --staged` is a single instruction printed twelve times.
 * - One subject with several faults is one line naming all of them, because
 *   they will be fixed in one edit to one file, and splitting them across rows
 *   makes one job look like three.
 *
 * Subjects sort by how broken they are, so the file worth opening first is
 * first.
 */
function renderTier(errors: Diagnostic[]): string[] {
  const commands = new Set(errors.map((item) => item.command ?? ""));
  if (errors.length > 1 && commands.size === 1 && !commands.has("")) {
    return [`     run: ${[...commands][0]}   (repairs all ${errors.length})`];
  }

  const bySubject = new Map<string, Diagnostic[]>();
  for (const diagnostic of errors) {
    const key = subjectOf(diagnostic) ?? diagnostic.message;
    bySubject.set(key, [...(bySubject.get(key) ?? []), diagnostic]);
  }
  const subjects = [...bySubject.entries()].sort(
    (left, right) => right[1].length - left[1].length || left[0].localeCompare(right[0]),
  );

  const lines: string[] = [];
  for (const [subject, items] of subjects.slice(0, 3)) {
    if (items.length === 1 && subjectOf(items[0]!) === undefined) {
      lines.push(`     ! ${items[0]!.message}`);
      continue;
    }
    const labels = [...new Set(items.map((item) => labelFor(item.code)))].join(", ");
    lines.push(`     ! ${subject}  ${labels}`);
    if (items.length === 1 && items[0]!.command) lines.push(`       run: ${items[0]!.command}`);
  }
  const hidden = subjects.slice(3).reduce((sum, [, items]) => sum + items.length, 0);
  if (hidden > 0) lines.push(`     ... and ${hidden} more in ${subjects.length - 3} subject(s)`);
  return lines;
}

export function renderRefusal(diagnostics: Diagnostic[]): string {
  const errors = diagnostics.filter((item) => item.severity === "error");
  const tiers = REFUSAL_TIERS.map((tier) => ({
    name: tier.name,
    errors: errors.filter(
      (item) =>
        REFUSAL_TIERS.find((candidate) => candidate.test(item.code))?.name === tier.name,
    ),
  })).filter((tier) => tier.errors.length > 0);

  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;
  const lines = [
    `commit blocked — ${plural(errors.length, "error")} in ${plural(tiers.length, "group")}, first cause first`,
    "",
  ];
  tiers.forEach((tier, index) => {
    lines.push(`  ${index + 1}. ${tier.name}   ${plural(tier.errors.length, "error")}`);
    lines.push(...renderTier(tier.errors));
    lines.push("");
  });

  // The reason the order is the order. Without it a reader treats the list as a
  // checklist and starts at whichever entry looks cheapest, which is usually one
  // that stops existing once the tier above it is fixed.
  if (tiers.length > 1) {
    lines.push(
      `  Fix group 1 first: the groups under it are computed from what it breaks, and some will not survive the repair.`,
    );
  }
  // Context for what the reader was just told to fix FIRST. Derived from the
  // input order instead, it offered lineage for the stale nodes in the last
  // group — the one already collapsed to a single command and the one thing
  // here nobody needs to read a file to repair.
  lines.push("  context:");
  const ordered = tiers.flatMap((tier) => tier.errors);
  for (const command of contextCommands(ordered).slice(0, 3)) lines.push(`    ${command}`);
  lines.push("    product-lint commit check --staged --full");
  return `${lines.join("\n")}\n`;
}

/**
 * What to do next, at the one moment the tool is certain to be read.
 *
 * Deliberately three rows. This fires on EVERY commit, and a fifteen-line wall
 * of opportunities is read for a week and skipped forever after — the failure
 * mode that kills a nagging report is the same one that kills a nagging linter.
 * Three is a nudge, the ordering makes the first one the one worth doing, and
 * the whole picture is one command away.
 *
 * Ordered by leverage rather than by locality. What you just touched is rarely
 * the highest-value thing to fix next, and scoping this to the diff would turn a
 * flywheel into a janitor.
 */
export function renderBrief(input: SummaryInput): string {
  const rows = summaryRows(input.diagnostics, input.graph);
  const limit = input.limit ?? 3;
  if (rows.length === 0 && !input.scope) return "";

  const lines: string[] = [];
  const shown = rows.slice(0, limit);
  if (shown.length > 0) {
    lines.push("next, highest leverage first:", "");
    const levelWidth = Math.max(...shown.map((row) => (row.level ?? "").length), 8);
    const labelWidth = Math.max(...shown.map((row) => row.label.length), 12);
    for (const row of shown) {
      lines.push(
        `  ${pad(row.level ?? "", levelWidth)}  ${pad(row.label, labelWidth)}  ${String(row.count).padStart(3)}${row.exemplar ? ` ${row.exemplar}` : ""}`,
      );
    }
  }

  // Collapsed, but never absent. The point of naming what is being ignored is
  // that a quiet report and a configured-quiet report look identical otherwise.
  const rest: string[] = [];
  const hidden = rows.slice(limit).reduce((sum, row) => sum + row.count, 0);
  if (hidden > 0) rest.push(`${hidden} more`);
  if (input.scope && input.scope.deferred > 0) {
    rest.push(`${input.scope.deferred} deferred by scope (${input.scope.because})`);
  }
  const ignored = input.ignored ?? [];
  if (ignored.length > 0) {
    const named = ignored
      .slice(0, 2)
      .map((entry) => `${entry.smell}${entry.nodeId ? ` on ${entry.nodeId}` : ""}`)
      .join(", ");
    rest.push(
      `${ignored.length} ignored (${named}${ignored.length > 2 ? `, +${ignored.length - 2}` : ""})`,
    );
  }
  if (rest.length > 0) lines.push("", `  ${rest.join(" · ")}`);
  if (lines.length > 0) lines.push("  product-lint check");
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}
