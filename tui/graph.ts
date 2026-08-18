/**
 * Reading the graph, and the three questions the panes ask of a selection.
 *
 * Everything here goes through the library in `src/`, never a second
 * implementation: the editor must not be able to disagree with the linter about
 * what the graph says.
 */
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { inspectWorkingTree } from "../src/status.js";
import { serializeNode } from "../src/graph.js";
import { buildVocabulary, resolveMarks } from "../src/terms.js";
import { sharedNounDiagnostics } from "../src/vocabulary.js";
import { KNOWLEDGE_LEVELS } from "../src/types.js";
import type {
  ResolvedConfig,
  SourceCanonicalNode,
  SourceReferenceNode,
  SourceTermNode,
} from "../src/types.js";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A node with many parents has many paths; the cycle stays finite. */
const MAX_PATHS = 24;

export interface Row {
  kind: "header" | "node";
  level: string;
  node?: SourceCanonicalNode;
}

export interface GraphView {
  rows: Row[];
  byId: Map<string, SourceCanonicalNode>;
  parents: Map<string, Set<string>>;
  children: Map<string, Set<string>>;
  references: SourceReferenceNode[];
  terms: SourceTermNode[];
  /** What `check` would say right now, folded to the one line a footer can hold. */
  status: string;
  complete: boolean;
  /**
   * Whether anything is actually WRONG, as against merely unfinished.
   *
   * The two are different states with different exit codes — 1 is invalid, 2 is
   * structurally valid but incomplete — and the graph itself claims that an
   * incomplete graph does not block work. Folding them into one "not complete"
   * flag would paint an owed node the same as a contradiction, which overstates
   * the owed node and cheapens the contradiction.
   */
  blocked: boolean;
}

export async function readGraph(config: ResolvedConfig): Promise<GraphView> {
  const status = await inspectWorkingTree(config);
  const graph = status.validation.graph;
  const byId = graph?.nodes ?? new Map<string, SourceCanonicalNode>();

  const rows: Row[] = [];
  for (const level of KNOWLEDGE_LEVELS) {
    const nodes = [...byId.values()]
      .filter((node) => node.level === level)
      .sort((a, b) => a.id.localeCompare(b.id));
    rows.push({ kind: "header", level });
    for (const node of nodes) rows.push({ kind: "node", level, node });
  }

  // Structural errors outrank an incomplete frontier, the same order `check`
  // uses for its exit code, so the footer never disagrees with the CLI.
  const errors = status.validation.diagnostics.length;
  const stale = status.synchronization.length;
  const owed = status.frontier.diagnostics.length;
  const parts: string[] = [];
  if (errors) parts.push(`${errors} invalid`);
  if (stale) parts.push(`${stale} stale`);
  if (owed) parts.push(`${owed} owed`);

  return {
    rows,
    byId,
    parents: graph?.parents ?? new Map(),
    children: graph?.children ?? new Map(),
    references: status.validation.references,
    terms: status.validation.terms,
    status: parts.length ? parts.join("  ") : "valid and complete",
    complete: parts.length === 0,
    blocked: errors + stale > 0,
  };
}

/**
 * Every root-to-node chain through `constrainedBy`, shallowest parent first.
 *
 * The graph is a validated DAG, so walking parents terminates without a seen
 * set. A node with no parents is its own path rather than no path, which keeps
 * the shallowest level selectable.
 */
export function pathsTo(view: GraphView, id: string): string[][] {
  const parents = [...(view.parents.get(id) ?? [])].sort();
  if (parents.length === 0) return [[id]];
  const out: string[][] = [];
  for (const parent of parents) {
    for (const prefix of pathsTo(view, parent)) {
      out.push([...prefix, id]);
      if (out.length >= MAX_PATHS) return out;
    }
  }
  return out.length > 0 ? out : [[id]];
}

/**
 * Every chain from this node down to a leaf, shallowest first.
 *
 * The mirror of `pathsTo`, which only ever climbs. A path view that stopped at
 * the focused node showed a node with two children as having none: the line it
 * drew was root-to-here, not the top-to-bottom line through it.
 */
export function pathsFrom(view: GraphView, id: string): string[][] {
  const children = [...(view.children.get(id) ?? [])].sort();
  if (children.length === 0) return [[id]];
  const out: string[][] = [];
  for (const child of children) {
    for (const suffix of pathsFrom(view, child)) {
      out.push([id, ...suffix]);
      if (out.length >= MAX_PATHS) return out;
    }
  }
  return out.length > 0 ? out : [[id]];
}

/**
 * Every top-to-bottom line through this node: what constrains it, itself, and
 * what rests on it. One line for each way up crossed with each way down.
 */
export function pathsThrough(view: GraphView, id: string): string[][] {
  const out: string[][] = [];
  for (const up of pathsTo(view, id)) {
    for (const down of pathsFrom(view, id)) {
      out.push([...up.slice(0, -1), ...down]);
      if (out.length >= MAX_PATHS) return out;
    }
  }
  return out.length > 0 ? out : [[id]];
}

/**
 * A word on the path, with what is known about it.
 *
 * The gloss is the point. A pane listing bare nouns tells you a word recurs and
 * nothing else, which is not worth the column it costs: what you need in order
 * to act is what the word means, or — for one nothing defines — how widely it
 * has spread without a definition.
 */
export interface Word {
  name: string;
  declared: boolean;
  /** Set only for a declared term, which has a level; a bare noun does not. */
  level?: string;
  /** Declared only: the authored definition, shown as content. */
  definition?: string;
  /** Undeclared only: how far the word has spread without one. */
  spread?: { uses: number; levels: number };
}

/**
 * The words the path uses, declared ones first.
 *
 * The undeclared half comes from the linter's own detector run over just the
 * selected nodes, rather than a second implementation here. Its threshold is two
 * levels and two uses, which is why this reads as empty for a one-node path and
 * fills in as the path gets longer — a word is not shared until something
 * shares it.
 */
export function wordsFor(view: GraphView, selectedPath: string[]): Word[] {
  const nodes = nodesOf(view, selectedPath);
  const vocabulary = buildVocabulary(view.terms);

  const declared = new Map<string, Word>();
  for (const node of nodes) {
    for (const term of resolveMarks(node.statement, vocabulary).terms) {
      declared.set(term.id, {
        name: term.name,
        declared: true,
        level: term.level,
        definition: term.definition,
      });
    }
  }

  const undeclared = sharedNounDiagnostics(nodes, view.terms).map((diagnostic) => {
    const details = diagnostic.details as { word: string; levels: string[]; total: number };
    return {
      name: details.word,
      declared: false,
      spread: { uses: details.total, levels: details.levels.length },
    };
  });

  return [...declared.values(), ...undeclared];
}

export function referencesFor(view: GraphView, selectedPath: string[]): SourceReferenceNode[] {
  const onPath = new Set(selectedPath);
  return view.references
    .filter((reference) => (reference.relatedNodes ?? []).some((id) => onPath.has(id)))
    .sort((left, right) => left.id.localeCompare(right.id));
}

export function nodesOf(view: GraphView, ids: string[]): SourceCanonicalNode[] {
  return ids
    .map((id) => view.byId.get(id))
    .filter((node): node is SourceCanonicalNode => Boolean(node));
}

export async function writeStatement(node: SourceCanonicalNode, statement: string): Promise<void> {
  const file = path.resolve(ROOT, node.sourcePath);
  const current = JSON.parse(await readFile(file, "utf8"));
  // Serialize through the library's own writer so the file this tool produces
  // is byte-identical to the file `sync` and `adopt` would produce.
  await writeFile(file, serializeNode({ ...current, statement, sourcePath: node.sourcePath }), "utf8");
}
