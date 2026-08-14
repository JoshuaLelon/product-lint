import type {
  Diagnostic,
  KnowledgeGraph,
  ResolvedConfig,
  SourceReferenceNode,
} from "./types.js";
import type { ResolvedScope } from "./scope.js";
import { fileChangedSince } from "./git.js";

/**
 * The one place this tool records that a claim was WRONG, made to resurface.
 *
 * Everything else it checks is missing, stale, or badly shaped — all of which
 * are facts about the graph's form. Nothing anywhere says a statement is false,
 * and nothing can, because that is a judgement and this tool makes no semantic
 * model calls. A `mistake` reference is how a person records the judgement
 * after the fact, with `relatedNodes` naming what it was about and `evidence`
 * anchoring it to the commit where it was learned.
 *
 * Until now that record was inert. References were read by `knowledge for-file`
 * and `affected-by` and by nothing else, so a mistake surfaced only if someone
 * already knew to ask about that exact node. The most expensive knowledge in the
 * repository — the kind you only get by being wrong — was the least likely to be
 * seen again.
 *
 * The finding is narrow on purpose: a mistake is reported only while the node it
 * names has NOT changed since the commit that recorded it. A claim someone
 * revised after learning it was wrong has been answered, and repeating it
 * forever would train a reader to skip the one report that carries hard-won
 * knowledge.
 */
export async function standingMistakeDiagnostics(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  references: SourceReferenceNode[],
  scope?: ResolvedScope,
): Promise<{ diagnostics: Diagnostic[]; deferred: number }> {
  const mistakes = references
    .filter((reference) => reference.kind === "mistake")
    .filter((reference) => reference.evidence?.commit && (reference.relatedNodes?.length ?? 0) > 0)
    .sort((left, right) => left.id.localeCompare(right.id));

  const diagnostics: Diagnostic[] = [];
  let deferred = 0;
  for (const reference of mistakes) {
    for (const nodeId of [...(reference.relatedNodes ?? [])].sort()) {
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      if (scope && !scope.inScope.has(nodeId)) {
        deferred += 1;
        continue;
      }
      // A draft has no claim to be wrong about yet.
      if (node.draft) continue;
      if (await fileChangedSince(config.root, reference.evidence!.commit, node.sourcePath)) {
        continue;
      }
      diagnostics.push({
        code: "PL0920 STANDING_MISTAKE",
        severity: "info",
        message: `${nodeId} has not changed since ${reference.id} recorded what went wrong: ${reference.statement}`,
        nodeId,
        path: node.sourcePath,
        action: "ask-user",
        details: {
          reference: reference.id,
          statement: reference.statement,
          commit: reference.evidence!.commit,
          node: { id: node.id, level: node.level, statement: node.statement },
          whenFine:
            "A mistake can be about the implementation rather than the claim, and then the statement is right and nothing here needs to change. Recording that is a one-line edit to the reference: drop the node from relatedNodes, or say in the statement which part was wrong.",
        },
      });
    }
  }
  return { diagnostics, deferred };
}
