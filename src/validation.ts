import type { RepositorySnapshot, ResolvedConfig, ValidationResult } from "./types.js";
import { buildKnowledgeGraph, loadCanonicalNodes } from "./graph.js";
import { loadReferences } from "./references.js";

export async function validateSnapshot(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
): Promise<ValidationResult> {
  const loaded = await loadCanonicalNodes(config, snapshot);
  const built = buildKnowledgeGraph(loaded.nodes);
  const references = await loadReferences(config, snapshot, built.graph);
  return {
    ...(built.graph ? { graph: built.graph } : {}),
    references: references.references,
    diagnostics: [...loaded.diagnostics, ...built.diagnostics, ...references.diagnostics],
  };
}
