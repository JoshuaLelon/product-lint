import type { Diagnostic, KnowledgeGraph, ResolvedConfig } from "./types.js";
import { ancestorsOf, descendantsOf } from "./graph.js";

/**
 * Which problems are being built right now.
 *
 * Scope silences OBLIGATIONS and never INVARIANTS. A deferred problem stops
 * demanding the levels below it; it does not stop its files being valid JSON,
 * its parents existing, its digests being current, or its words resolving. A
 * malformed file breaks the whole graph regardless of what is being shipped.
 */
export interface ResolvedScope {
  roots: string[];
  because: string;
  /** Roots, everything under them, and everything above them. */
  inScope: Set<string>;
  /** Roots of the same level that no in-scope closure reaches. */
  deferredRoots: string[];
  /**
   * In-scope nodes that a deferred root also reaches. Not a fault — it is the
   * news that the deferred problems are already partly built, which is worth
   * knowing before deciding they are deferred.
   */
  contested: string[];
}

/**
 * PL1401: a root naming a node that does not exist. An error rather than a
 * warning because the failure is silent and total — a typo in one id scopes the
 * graph to nothing reachable and the whole report goes quiet, which reads
 * exactly like a clean repository.
 */
export function scopeDiagnostics(config: ResolvedConfig, graph: KnowledgeGraph): Diagnostic[] {
  if (!config.scope) return [];
  return config.scope.roots
    .filter((id) => !graph.nodes.has(id))
    .sort()
    .map((id) => ({
      code: "PL1401 UNKNOWN_SCOPE_ROOT",
      severity: "error" as const,
      message: `scope.roots names ${id}, which no node declares.`,
      path: config.configPath,
      nodeId: id,
      action: "edit-node" as const,
      details: { root: id, roots: config.scope!.roots },
    }));
}

export function resolveScope(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
): ResolvedScope | undefined {
  if (!config.scope) return undefined;
  const roots = config.scope.roots.filter((id) => graph.nodes.has(id));
  if (roots.length === 0) return undefined;

  // Ancestors are in scope because a context root's audience parent is
  // load-bearing for it: dropping it would hold back the one question that
  // decides who the kept problem is even for.
  const inScope = new Set([...descendantsOf(graph, roots), ...ancestorsOf(graph, roots)]);

  // The lesson `sliceForAudience` already carries: the deferred set is the
  // COMPLEMENT of the in-scope closure, never the closure of the other roots.
  // Those two differ wherever a node has more than one parent, which is most
  // real graphs — growing "deferred" downward from the roots left over defers
  // every node the kept problems happen to share with them.
  const rootLevel = graph.nodes.get(roots[0]!)!.level;
  const kept = new Set(roots);
  const deferredRoots = [...graph.nodes.values()]
    .filter((node) => node.level === rootLevel && !kept.has(node.id))
    .map((node) => node.id)
    .sort();

  // What the complement costs, stated: nodes serving a kept problem AND a
  // deferred one. Reported as a count, never as a fault.
  const deferredReach = descendantsOf(graph, deferredRoots);
  const contested = [...inScope]
    .filter((id) => deferredReach.has(id) && !kept.has(id))
    .sort();

  return { roots: [...roots].sort(), because: config.scope.because, inScope, deferredRoots, contested };
}
