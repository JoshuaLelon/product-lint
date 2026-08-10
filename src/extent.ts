import type { KnowledgeGraph, KnowledgeLevel, RepositorySnapshot } from "./types.js";
import { filesForMechanism } from "./frontier.js";

/**
 * The set of governed files a node reaches through its Mechanism descendants.
 *
 * A node's statement is prose and prose has no arithmetic. Its extent does. It
 * is the second, decidable denotation of the same claim, and it is what makes
 * "these two nodes overlap" answerable at the one level where nodes bind to
 * files.
 *
 * Its reach is worth stating plainly, because it is smaller than it looks. A
 * knowledge forest that never re-merges — no node with two parents — gives
 * siblings disjoint extents by tree shape alone, whatever their statements say.
 * Above Mechanism, extent then measures the shape of the tree and not the
 * meaning of the nodes. Read it as evidence only where nodes can actually
 * collide.
 */
export interface ExtentIndex {
  extentOf(nodeId: string): ReadonlySet<string>;
}

/**
 * Memoized per call, never per module. `checkStagedCommit` holds a HEAD graph
 * and a staged graph in one process, and a cache keyed by node id alone would
 * answer one with the other.
 */
export function createExtentIndex(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
): ExtentIndex {
  const memo = new Map<string, Set<string>>();

  // Reverse topological order visits every child before its parent, so each
  // node unions sets that are already final. A DAG that re-merges reaches the
  // same child twice; the memo absorbs that.
  for (const id of [...graph.topologicalOrder].reverse()) {
    const node = graph.nodes.get(id);
    if (!node) continue;
    const files = new Set<string>(
      node.level === "mechanism" ? filesForMechanism(graph, id, snapshot) : [],
    );
    for (const childId of graph.children.get(id) ?? []) {
      for (const file of memo.get(childId) ?? []) files.add(file);
    }
    memo.set(id, files);
  }

  return {
    extentOf(nodeId: string): ReadonlySet<string> {
      return memo.get(nodeId) ?? new Set<string>();
    },
  };
}

/**
 * A cohort is the children of one parent at one level.
 *
 * This is the unit at which mutual exclusivity is a question at all. A level
 * taken whole mixes nodes answering different parents, and two of those are not
 * required to be exclusive. Two children of the same parent are.
 */
export interface Cohort {
  parentId: string;
  level: KnowledgeLevel;
  memberIds: string[];
}

export function cohortsOf(graph: KnowledgeGraph): Cohort[] {
  const grouped = new Map<string, Cohort>();
  for (const [parentId, childIds] of graph.children) {
    for (const childId of childIds) {
      const child = graph.nodes.get(childId);
      if (!child) continue;
      const key = `${parentId}/${child.level}`;
      const existing = grouped.get(key);
      if (existing) existing.memberIds.push(childId);
      else grouped.set(key, { parentId, level: child.level, memberIds: [childId] });
    }
  }
  const cohorts = [...grouped.values()];
  // Code-unit ordering, not localeCompare: these keys reach a digest, and
  // localeCompare depends on the ICU build of the Node that ran it.
  for (const cohort of cohorts) cohort.memberIds.sort(byCodeUnit);
  cohorts.sort((left, right) => byCodeUnit(cohortKey(left), cohortKey(right)));
  return cohorts;
}

export function cohortKey(cohort: Cohort | { parentId: string; level: KnowledgeLevel }): string {
  return `${cohort.parentId}/${cohort.level}`;
}

export function byCodeUnit(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
