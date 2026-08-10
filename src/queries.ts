import type {
  AffectedKnowledgeResult,
  Audience,
  FileKnowledgeResult,
  KnowledgeGraph,
  RepositorySnapshot,
  SourceCanonicalNode,
  SourceReferenceNode,
} from "./types.js";
import {
  audienceOverlaps,
  audienceSets,
  combinedAudience,
  formatAudience,
  parseSelector,
  resolveAudiences,
} from "./audience.js";
import { matchesAny, normalizePath } from "./glob.js";
import { ancestorsOf, descendantsOf } from "./graph.js";
import { filesForMechanism } from "./frontier.js";

/**
 * The audience these nodes serve, resolved rather than read off the lineage.
 * Empty when the graph has no audience sets, so a graph that does not use them
 * prints nothing rather than a row of asterisks.
 */
function describeAudience(graph: KnowledgeGraph, ids: string[]): string | undefined {
  const axes = [...audienceSets(graph).keys()].sort();
  if (axes.length === 0) return undefined;
  return formatAudience(combinedAudience(resolveAudiences(graph), ids, axes), axes);
}

function orderedNodes(graph: KnowledgeGraph, ids: Set<string>): SourceCanonicalNode[] {
  return graph.topologicalOrder
    .filter((id) => ids.has(id))
    .map((id) => graph.nodes.get(id)!)
    .filter(Boolean);
}

function relevantReferences(
  references: SourceReferenceNode[],
  nodeIds: Set<string>,
  file?: string,
): SourceReferenceNode[] {
  const normalizedFile = file ? normalizePath(file) : undefined;
  return references.filter((reference) => {
    if (reference.relatedNodes?.some((id) => nodeIds.has(id))) return true;
    if (
      normalizedFile &&
      reference.evidence?.files.some((item) => normalizePath(item.path) === normalizedFile)
    ) {
      return true;
    }
    return false;
  });
}

export function knowledgeForFile(
  graph: KnowledgeGraph,
  references: SourceReferenceNode[],
  file: string,
): FileKnowledgeResult {
  const normalized = normalizePath(file);
  const mechanisms = [...graph.nodes.values()]
    .filter(
      (node) =>
        node.level === "mechanism" &&
        node.implementation &&
        matchesAny(normalized, node.implementation.files),
    )
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = ancestorsOf(graph, mechanisms.map((node) => node.id));
  return {
    file: normalized,
    mechanisms,
    lineage: orderedNodes(graph, ids),
    audience: describeAudience(graph, mechanisms.map((node) => node.id)),
    references: relevantReferences(references, ids, normalized),
  };
}

export interface SliceResult {
  keep: string;
  axes: string[];
  keptNodes: SourceCanonicalNode[];
  mockedNodes: SourceCanonicalNode[];
  keptFiles: string[];
  mockedFiles: string[];
  contestedFiles: string[];
}

/**
 * Split the repository into what one audience needs and what may be mocked.
 *
 * The mock set is the COMPLEMENT of the keep closure, never the closure of a
 * mock root. Those two differ whenever a node has more than one parent, which
 * is most real graphs: growing a mock set downward from "everyone else" stubs
 * every node the kept audience happens to share with them. `contestedFiles`
 * reports exactly that difference, because a file two audiences both need is
 * worth seeing rather than silently resolving.
 */
export function sliceForAudience(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  selector: string,
): SliceResult {
  const sets = audienceSets(graph);
  if (sets.size === 0) throw new Error("This graph has no audience sets to slice by.");
  const axes = [...sets.keys()].sort();
  const keep: Audience = [parseSelector(selector, sets)];
  const resolved = resolveAudiences(graph);

  const kept: SourceCanonicalNode[] = [];
  const mocked: SourceCanonicalNode[] = [];
  for (const id of graph.topologicalOrder) {
    const node = graph.nodes.get(id)!;
    if (node.level === "audience") continue;
    const audience = resolved.get(id) ?? [];
    if (audience.length > 0 && audienceOverlaps(audience, keep, axes)) kept.push(node);
    else mocked.push(node);
  }

  const filesOf = (list: SourceCanonicalNode[]) =>
    new Set(
      list
        .filter((node) => node.level === "mechanism")
        .flatMap((node) => filesForMechanism(graph, node.id, snapshot)),
    );
  const keptFiles = filesOf(kept);
  const mockedFiles = filesOf(mocked);
  // What a naive "closure of everyone else" would have stubbed and should not.
  const contested = [...mockedFiles].filter((file) => keptFiles.has(file)).sort();

  return {
    keep: selector,
    axes,
    keptNodes: kept,
    mockedNodes: mocked,
    keptFiles: [...keptFiles].sort(),
    mockedFiles: [...mockedFiles].filter((file) => !keptFiles.has(file)).sort(),
    contestedFiles: contested,
  };
}

export function affectedByNode(
  graph: KnowledgeGraph,
  references: SourceReferenceNode[],
  snapshot: RepositorySnapshot,
  nodeId: string,
): AffectedKnowledgeResult {
  const node = graph.nodes.get(nodeId);
  if (!node) throw new Error(`Unknown knowledge node: ${nodeId}`);
  const ids = descendantsOf(graph, [nodeId]);
  ids.delete(nodeId);
  const descendants = orderedNodes(graph, ids);
  const mechanisms = descendants
    .filter((item) => item.level === "mechanism")
    .sort((left, right) => left.id.localeCompare(right.id));
  if (node.level === "mechanism") mechanisms.unshift(node);
  const files = [...new Set(mechanisms.flatMap((item) => filesForMechanism(graph, item.id, snapshot)))].sort();
  const relevantIds = new Set([nodeId, ...ids]);
  return {
    node,
    descendants,
    mechanisms,
    files,
    audience: describeAudience(graph, [nodeId]),
    references: relevantReferences(references, relevantIds),
  };
}

