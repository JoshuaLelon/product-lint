import type {
  AffectedKnowledgeResult,
  FileKnowledgeResult,
  KnowledgeGraph,
  RepositorySnapshot,
  SourceCanonicalNode,
  SourceReferenceNode,
} from "./types.js";
import { matchesAny, normalizePath } from "./glob.js";
import { ancestorsOf, descendantsOf } from "./graph.js";
import { filesForMechanism } from "./frontier.js";

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
    references: relevantReferences(references, ids, normalized),
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
    references: relevantReferences(references, relevantIds),
  };
}

