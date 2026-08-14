import type {
  Diagnostic,
  KnowledgeGraph,
  KnowledgeLevel,
  ResolvedConfig,
  SourceCanonicalNode,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import type { ResolvedScope } from "./scope.js";
import { levelIndex } from "./terms.js";

/**
 * Shape findings: what the forest looks like, as against whether it is filled in.
 *
 * Every check before this one is LOCAL — PL0201 asks whether this node has a
 * child at behavior, PL1104 whether this node's parent exists. None of them look
 * at the distribution. A graph can pass `ship` with exit 0 and still be a mess,
 * and the mess is legible: the ways a DAG forest can be badly shaped have names,
 * and several of them map onto product problems.
 *
 * Two rules belong to the harness rather than to any detector, because getting
 * either wrong once would poison every smell that ever lands here:
 *
 * 1. Draft nodes are invisible. A freshly adopted repository is N identical
 *    1-1-1-1-1-1 chains, which is a degenerate forest — every distribution
 *    metric would fire on scaffolding and the report would be useless at exactly
 *    the moment someone first reads it.
 * 2. Out-of-scope nodes are invisible, and counted. Same contract as every other
 *    report: the quiet is stated, never assumed.
 *
 * And one rule belongs to every finding: it must say what would make the shape
 * correct. These are all "usually fine, sometimes a tell" — a product may
 * genuinely have one core problem — so a finding that only accuses is noise.
 * `whenFine` is a required field rather than a convention, so the next smell
 * cannot skip it.
 */
export interface SmellFinding {
  smell: string;
  level: KnowledgeLevel;
  nodeId?: string;
  message: string;
  /** The reading under which this shape is correct. Required. */
  whenFine: string;
  details?: Record<string, unknown>;
}

export interface SmellContext {
  graph: KnowledgeGraph;
  /** Real, in-scope nodes. Detectors never see a draft or a deferred node. */
  eligible: SourceCanonicalNode[];
  at(level: KnowledgeLevel): SourceCanonicalNode[];
  childrenOf(nodeId: string, level: KnowledgeLevel): string[];
}

export interface SmellDefinition {
  /** The key `smells.ignore` names, and the word the report prints. */
  name: string;
  code: string;
  detect(context: SmellContext): SmellFinding[];
}

/**
 * Thresholds are fixed and versioned, never configurable. This list is part of
 * the deterministic contract in the same way STOPWORDS is: a threshold a reader
 * can tune is a threshold that gets tuned until the report is empty, which is a
 * suppression list wearing a number. Turning a smell OFF stays possible, and it
 * costs a recorded reason.
 */
const IMBALANCE = {
  /** Below this many parents a share means nothing: two parents split 60/40 by arithmetic. */
  minimumParents: 3,
  /** Below this many children the ratio is noise, not a distribution. */
  minimumChildren: 5,
  /** The share of a level one parent has to hold before the shape is worth a look. */
  share: 0.6,
} as const;

/**
 * UNBUILT, and deliberately: the restructuring this smell tells you to perform.
 *
 * `imbalance`'s repair is "split it and re-parent its children", and
 * `PL0802 SYNONYM_CANDIDATE`'s is "delete one term and rewrite the loser's
 * uses". Both mean: delete N nodes, add M, rewrite `constrainedBy` on K
 * children. `constrainedBy` is inside `semanticProjection`, so every re-parented
 * child is a semantic change and `PL2202` demands a declaration for each.
 * Splitting `context.core` with six product-law children is nine trailers for
 * one decision. (Only nine: the descendants of those six go stale too, but their
 * rewrites are `synchronizationOnly` and owe nothing.) The newest feature here
 * prescribes the most expensive operation in the tool.
 *
 * Three shapes, kept here rather than in a document that nothing keeps honest,
 * so the choice can be made when the dogfood produces a real split:
 *
 * 1. CALCULATOR. `restructure plan split <id> --into a,b` prints the
 *    consequence — which children move, what goes stale — plus a copy-paste
 *    trailer block, and writes nothing. Trailers stay at nine; the tool only
 *    removes the arithmetic. No state, no new trailer form, no new lifecycle.
 *    Cannot guarantee the plan is what gets written.
 * 2. WRITER. `split <id> --into a --take x,y --into b --take z` writes both new
 *    nodes as `draft: true`, rewrites the children, deletes the original; the
 *    statements stay the author's job. Adds `Knowledge-Restructured: old -> a, b`
 *    by direct analogy with `Knowledge-Renamed`, which already collapses two node
 *    events into one declaration — so nine trailers become one, and it is
 *    CHECKABLE: the commit path can verify each child moved from source to a
 *    declared target. Cannot express a chain, and forces drafts even on a pure
 *    re-parent that needs no new prose.
 * 3. TRANSACTION. `restructure begin/split/reparent/merge/apply` appends
 *    operations to a log, replays at apply, commits the log as the record. One
 *    trailer; the only shape where a multi-step refactor reads in history as one
 *    decision with its reasoning. Costs on-disk state, a begin/abandon/apply
 *    lifecycle, a reaper for abandoned logs, and the log is a second copy of a
 *    derivable fact once applied — the sidecar pattern that gets deleted later.
 *
 * What decides it, watched while walking a real graph up: how many nodes a
 * restructure actually touches (two or three makes the trailer problem
 * imaginary and shape 1 the whole answer); whether splits produce new problems
 * needing prose or are pure re-parenting (shape 2's drafts are wrong for the
 * second, holding `ship` red over nodes owing nothing); whether restructures
 * chain (only chaining justifies shape 3); whether `classifyDeletions`'
 * similarity matcher mis-pairs when both new nodes partly resemble the original;
 * and whether nine pasted trailer lines are actually annoying. The cheapest
 * honest outcome is that they are fine and the right build is shape 1, or none.
 */
const imbalance: SmellDefinition = {
  name: "imbalance",
  code: "PL0910 IMBALANCE",
  detect(context) {
    const findings: SmellFinding[] = [];
    for (let index = 1; index < KNOWLEDGE_LEVELS.length; index += 1) {
      const childLevel = KNOWLEDGE_LEVELS[index]!;
      const parentLevel = KNOWLEDGE_LEVELS[index - 1]!;
      const parents = context.at(parentLevel);
      const children = context.at(childLevel);
      if (parents.length < IMBALANCE.minimumParents) continue;
      if (children.length < IMBALANCE.minimumChildren) continue;

      for (const parent of parents) {
        const held = context.childrenOf(parent.id, childLevel);
        const share = held.length / children.length;
        if (share < IMBALANCE.share) continue;
        const others = parents.filter((item) => item.id !== parent.id);
        findings.push({
          smell: "imbalance",
          level: parentLevel,
          nodeId: parent.id,
          message: `${parent.id} holds ${held.length} of ${children.length} ${childLevel} node(s), and ${others.length} sibling(s) share the rest.`,
          whenFine:
            "A product can have one core problem and several adjacent ones, and then this is the true shape. The question is whether the dominant node is one thing or several wearing one name — and whether the thin siblings are underbuilt or do not belong.",
          details: {
            held: held.length,
            total: children.length,
            share: Number(share.toFixed(2)),
            siblings: others.map((item) => ({
              id: item.id,
              held: context.childrenOf(item.id, childLevel).length,
            })),
          },
        });
      }
    }
    return findings;
  },
};

/** Every smell the tool knows. Adding one is an entry here and a detect(). */
export const SMELLS: SmellDefinition[] = [imbalance];

export interface SmellReport {
  diagnostics: Diagnostic[];
  /** Findings held back because their node is out of scope. */
  deferred: number;
  /** Findings held back by smells.ignore, with the reason given for each. */
  ignored: { smell: string; nodeId?: string; because: string }[];
}

function buildContext(graph: KnowledgeGraph, eligible: SourceCanonicalNode[]): SmellContext {
  const byId = new Set(eligible.map((node) => node.id));
  return {
    graph,
    eligible,
    at: (level) => eligible.filter((node) => node.level === level),
    childrenOf: (nodeId, level) =>
      [...(graph.children.get(nodeId) ?? [])].filter(
        (childId) => byId.has(childId) && graph.nodes.get(childId)?.level === level,
      ),
  };
}

export function detectSmells(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  scope?: ResolvedScope,
): SmellReport {
  // Rule 1 and rule 2, applied once for every smell that will ever exist.
  const real = [...graph.nodes.values()].filter((node) => !node.draft);
  const eligible = real.filter((node) => !scope || scope.inScope.has(node.id));
  const context = buildContext(graph, eligible);

  const findings = SMELLS.flatMap((smell) => smell.detect(context));
  const ignores = config.smells?.ignore ?? [];
  const ignored: SmellReport["ignored"] = [];
  const kept: SmellFinding[] = [];
  for (const finding of findings) {
    const rule = ignores.find(
      (entry) => entry.smell === finding.smell && (!entry.node || entry.node === finding.nodeId),
    );
    if (rule) {
      ignored.push({
        smell: finding.smell,
        ...(finding.nodeId ? { nodeId: finding.nodeId } : {}),
        because: rule.because,
      });
      continue;
    }
    kept.push(finding);
  }

  // Shallowest level first, because that is the order of leverage: a problem
  // decides what every node beneath it is even for, so a finding there is worth
  // more than a tidier one four levels down.
  kept.sort(
    (left, right) =>
      levelIndex(left.level) - levelIndex(right.level) ||
      left.smell.localeCompare(right.smell) ||
      (left.nodeId ?? "").localeCompare(right.nodeId ?? ""),
  );

  const codeFor = new Map(SMELLS.map((smell) => [smell.name, smell.code]));
  const deferredCount = scope
    ? SMELLS.flatMap((smell) => smell.detect(buildContext(graph, real))).length - findings.length
    : 0;

  return {
    diagnostics: kept.map((finding) => ({
      code: codeFor.get(finding.smell)!,
      severity: "info" as const,
      message: finding.message,
      ...(finding.nodeId ? { nodeId: finding.nodeId } : {}),
      ...(graph.nodes.get(finding.nodeId ?? "")?.sourcePath
        ? { path: graph.nodes.get(finding.nodeId!)!.sourcePath }
        : {}),
      action: "inspect" as const,
      details: { smell: finding.smell, whenFine: finding.whenFine, ...finding.details },
    })),
    deferred: Math.max(0, deferredCount),
    ignored,
  };
}

/** PL1402: an ignore naming a smell that does not exist silences nothing, quietly. */
export function smellConfigDiagnostics(config: ResolvedConfig): Diagnostic[] {
  const known = new Set(SMELLS.map((smell) => smell.name));
  return (config.smells?.ignore ?? [])
    .filter((entry) => !known.has(entry.smell))
    .map((entry) => ({
      code: "PL1402 UNKNOWN_SMELL",
      severity: "error" as const,
      message: `smells.ignore names "${entry.smell}", which is not a smell this version detects. Known: ${[...known].sort().join(", ")}.`,
      path: config.configPath,
      action: "edit-node" as const,
      details: { smell: entry.smell, known: [...known].sort() },
    }));
}
