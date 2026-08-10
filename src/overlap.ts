import type { Diagnostic, KnowledgeGraph, RepositorySnapshot, SourceCanonicalNode } from "./types.js";
import { matchesAny } from "./glob.js";

/**
 * Two Mechanism nodes that claim the same file.
 *
 * A level is meant to be a set of nodes that do not overlap. Between two prose
 * statements that has no deterministic test, which is why NODE_SHAPE instructs
 * rather than enforces. Between two Mechanism nodes it does: a Mechanism binds
 * to files, so the file the snapshot holds is evidence, not a reading. This is
 * the same standard PL0502 already meets — a claim the repository disproves.
 *
 * It is worth naming for a reason beyond shape. `checkStagedCommit` requires
 * EVERY owner of a changed file to be staged, so a file with two owners quietly
 * doubles the PL2102 burden, and nothing today says why.
 */
export function overlappingMechanisms(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
): Diagnostic[] {
  // An empty snapshot is no evidence either way, exactly as in PL0502: a head
  // snapshot of a repository with no commits lists no files, and every node
  // would read as owning nothing and overlapping nobody.
  if (snapshot.files.length === 0) return [];

  const mechanisms = [...graph.nodes.values()]
    .filter((node) => node.level === "mechanism" && node.implementation)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  if (mechanisms.length < 2) return [];

  const extents = new Map<string, Set<string>>();
  for (const node of mechanisms) {
    extents.set(
      node.id,
      new Set(snapshot.files.filter((file) => matchesAny(file, node.implementation!.files))),
    );
  }

  const diagnostics: Diagnostic[] = [];
  for (let left = 0; left < mechanisms.length; left += 1) {
    for (let right = left + 1; right < mechanisms.length; right += 1) {
      const one = mechanisms[left]!;
      const other = mechanisms[right]!;
      const oneFiles = extents.get(one.id)!;
      const otherFiles = extents.get(other.id)!;
      const shared = [...oneFiles].filter((file) => otherFiles.has(file)).sort();
      if (shared.length === 0) continue;
      diagnostics.push(overlapDiagnostic(one, other, oneFiles, otherFiles, shared));
    }
  }
  return diagnostics;
}

function overlapDiagnostic(
  one: SourceCanonicalNode,
  other: SourceCanonicalNode,
  oneFiles: Set<string>,
  otherFiles: Set<string>,
  shared: string[],
): Diagnostic {
  // Containment is the sharper case and gets said out loud. One node's files
  // sitting entirely inside another's is almost never two concerns that happen
  // to touch; it is one node restating part of another, and the repair is a
  // merge rather than a re-partition. It stays one code because the repair
  // sentence covers both, and a second code would split one fact in two.
  const containment =
    shared.length === oneFiles.size
      ? { inner: one.id, outer: other.id }
      : shared.length === otherFiles.size
        ? { inner: other.id, outer: one.id }
        : undefined;

  const relation = containment
    ? `${containment.outer} claims every file ${containment.inner} claims`
    : `${one.id} and ${other.id} both claim ${shared.length} file(s)`;

  return {
    code: "PL0603 OVERLAPPING_MECHANISM",
    severity: "error",
    message: `${relation}. A governed file has one Mechanism owner.`,
    nodeId: one.id,
    path: one.sourcePath,
    action: "edit-node",
    details: {
      mechanisms: [one.id, other.id],
      ...(containment ? { containment } : {}),
      // `files` renders as a tree, so the shared set is the list a reader wants.
      files: shared,
    },
  };
}
