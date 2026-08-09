import type {
  Diagnostic,
  KnowledgeGraph,
  RepositorySnapshot,
  ResolvedConfig,
  ValidationResult,
} from "./types.js";
import { buildKnowledgeGraph, loadCanonicalNodes } from "./graph.js";
import { loadReferences } from "./references.js";
import { matchesGlob, normalizePath } from "./glob.js";

const GLOB_METACHARACTERS = /[*?{]/;

function resolvesToAFile(entry: string, snapshot: RepositorySnapshot): boolean {
  if (!GLOB_METACHARACTERS.test(entry)) return snapshot.hasFile(normalizePath(entry));
  return snapshot.files.some((file) => matchesGlob(file, entry));
}

/**
 * A dead entry that the change itself proves is gone: a literal path HEAD had
 * and this snapshot does not. Synchronization prunes exactly these, because the
 * deletion is the evidence and no product judgement is left to make.
 *
 * Nothing else qualifies, which is the point. A typo never existed in HEAD. A
 * path moved outside a hooked commit is absent from HEAD and from the index
 * alike. Both keep reporting PL0502, so pruning never hides a false claim.
 */
export function prunableDeadPath(
  entry: string,
  snapshot: RepositorySnapshot,
  previous: RepositorySnapshot,
): boolean {
  if (GLOB_METACHARACTERS.test(entry)) return false;
  const normalized = normalizePath(entry);
  return !snapshot.hasFile(normalized) && previous.hasFile(normalized);
}

/**
 * A Mechanism claims each implementation entry separately, but matching has
 * always collapsed the whole list into one boolean. An entry that resolves to
 * nothing was therefore invisible beside a sibling that resolved: the node
 * claimed two files, governed one, and the graph still reported as complete.
 * Check every entry on its own so a false claim is named.
 */
function deadImplementationPaths(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
): Diagnostic[] {
  // An empty snapshot is no evidence either way. A head snapshot of a
  // repository with no commits lists no files, and every path would read as
  // dead. Canonical nodes are themselves loaded from the snapshot, so today
  // that graph is empty too; the guard keeps the check honest if a caller ever
  // pairs a graph with a snapshot it did not come from.
  if (snapshot.files.length === 0) return [];
  const diagnostics: Diagnostic[] = [];
  for (const node of graph.nodes.values()) {
    if (node.level !== "mechanism" || !node.implementation) continue;
    const entries = node.implementation.files;
    const dead = entries.filter((entry) => !resolvesToAFile(entry, snapshot));
    // Every entry dead is the same fact as "resolves to no implementation
    // files", which is PL0501, and PL0501 says it better. One fact, one
    // diagnostic.
    if (dead.length === 0 || dead.length === entries.length) continue;
    for (const entry of dead) {
      diagnostics.push({
        code: "PL0502 DEAD_IMPLEMENTATION_PATH",
        severity: "error",
        message: `${node.id} claims ${entry}, which matches no file.`,
        path: node.sourcePath,
        nodeId: node.id,
        action: "edit-node",
        details: { deadPath: entry, implementationFiles: entries },
      });
    }
  }
  return diagnostics;
}

export async function validateSnapshot(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
): Promise<ValidationResult> {
  const loaded = await loadCanonicalNodes(config, snapshot);
  const built = buildKnowledgeGraph(loaded.nodes);
  const references = await loadReferences(config, snapshot, built.graph);
  const implementation = built.graph ? deadImplementationPaths(built.graph, snapshot) : [];
  return {
    ...(built.graph ? { graph: built.graph } : {}),
    references: references.references,
    diagnostics: [
      ...loaded.diagnostics,
      ...built.diagnostics,
      ...implementation,
      ...references.diagnostics,
    ],
  };
}
