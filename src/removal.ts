import type {
  DeletionClassification,
  Diagnostic,
  KnowledgeGraph,
  NodeChangeClassification,
  RenamePair,
  ResolvedConfig,
  SourceCanonicalNode,
  SourceTermNode,
} from "./types.js";
import { contentTokens } from "./vocabulary.js";

/**
 * A node can leave this graph without a trace as long as it was nobody's
 * parent. A parent deletion dangles its children and dies in validation
 * (PL1102), so everything here is scoped to leaves by subtraction, not by a
 * test. The staged diff already computes the deleted set; what it cannot
 * compute is intent, and both legitimate kinds of deletion — a removal and a
 * rename — produce the same D line. This module tells them apart well enough
 * to report, and only to report: the classification chooses suggestions and
 * severity, never obligations. The record an author must write is enforced
 * against the diff alone, in commit.ts.
 */

interface Candidate {
  deletedId: string;
  addedId: string;
  similarity: number;
  shared: number;
  parentsEqual: boolean;
}

function jaccard(one: Set<string>, other: Set<string>): { similarity: number; shared: number } {
  const shared = [...one].filter((token) => other.has(token)).length;
  const union = new Set([...one, ...other]).size;
  return { similarity: union === 0 ? 0 : shared / union, shared };
}

function sortedParents(node: SourceCanonicalNode): string {
  return JSON.stringify([...node.constrainedBy].sort());
}

/**
 * The pairing rule, verified against pantogen 81c8294: renames in practice
 * rewrite the statement (8 of 9 scored 0.08–0.43), so the statement convinces
 * alone only at PL0802's threshold, and below it the exact parent set carries
 * the pairing, with one shared content word as the floor. Greedy descending
 * order is what stops an unrelated deletion from stealing a true rename's
 * partner inside a shared bucket. Terms pair on their definitions alone — a
 * term has no parents.
 *
 * The evidence base is one commit produced by one rename tool, which carried
 * constrainedBy forward verbatim (9 of 9). A rename that moves parents and
 * rewrites the statement falls through both passes and reads as a removal —
 * one spurious question. The opposite error is quieter and larger: an
 * unrelated same-parent addition sharing one word pairs, and the removal
 * warning is suppressed. That asymmetry is why a parents-basis pair is
 * reported as a question rather than a note (see deletionDiagnostics), and
 * why no similarity floor guards pass 2 — the floor that would exclude a
 * wrong pair at 0.14 also excludes true restatements at 0.13 and 0.08.
 */
export function classifyDeletions(
  head: KnowledgeGraph | undefined,
  staged: KnowledgeGraph | undefined,
  headTerms: SourceTermNode[],
  stagedTerms: SourceTermNode[],
  changes: NodeChangeClassification,
): DeletionClassification {
  const headTermsById = new Map(headTerms.map((term) => [term.id, term]));
  const stagedTermsById = new Map(stagedTerms.map((term) => [term.id, term]));
  const deletedIds = [...changes.deleted].sort();
  const addedIds = [...changes.added].sort();

  const candidates: Candidate[] = [];
  for (const deletedId of deletedIds) {
    for (const addedId of addedIds) {
      const deletedNode = head?.nodes.get(deletedId);
      const addedNode = staged?.nodes.get(addedId);
      if (deletedNode && addedNode) {
        if (deletedNode.level !== addedNode.level) continue;
        const { similarity, shared } = jaccard(
          contentTokens(deletedNode.statement),
          contentTokens(addedNode.statement),
        );
        candidates.push({
          deletedId,
          addedId,
          similarity,
          shared,
          parentsEqual: sortedParents(deletedNode) === sortedParents(addedNode),
        });
        continue;
      }
      const deletedTerm = headTermsById.get(deletedId);
      const addedTerm = stagedTermsById.get(addedId);
      if (deletedTerm && addedTerm) {
        const { similarity, shared } = jaccard(
          contentTokens(deletedTerm.definition),
          contentTokens(addedTerm.definition),
        );
        candidates.push({ deletedId, addedId, similarity, shared, parentsEqual: false });
      }
    }
  }

  candidates.sort(
    (left, right) =>
      right.similarity - left.similarity ||
      left.deletedId.localeCompare(right.deletedId) ||
      left.addedId.localeCompare(right.addedId),
  );

  const renames: RenamePair[] = [];
  const pairedDeleted = new Set<string>();
  const pairedAdded = new Set<string>();
  const accept = (candidate: Candidate, basis: RenamePair["basis"]) => {
    renames.push({
      deletedId: candidate.deletedId,
      addedId: candidate.addedId,
      similarity: candidate.similarity,
      basis,
    });
    pairedDeleted.add(candidate.deletedId);
    pairedAdded.add(candidate.addedId);
  };

  for (const candidate of candidates) {
    if (candidate.similarity < 0.5) break;
    if (pairedDeleted.has(candidate.deletedId) || pairedAdded.has(candidate.addedId)) continue;
    accept(candidate, "statement");
  }
  for (const candidate of candidates) {
    if (!candidate.parentsEqual || candidate.shared < 1) continue;
    if (pairedDeleted.has(candidate.deletedId) || pairedAdded.has(candidate.addedId)) continue;
    accept(candidate, "parents");
  }

  renames.sort((left, right) => left.deletedId.localeCompare(right.deletedId));
  return {
    renames,
    removals: deletedIds.filter((id) => !pairedDeleted.has(id)),
  };
}

/** Staged nodes at a level that list this parent, for the question a removal asks. */
function remainingChildren(
  staged: KnowledgeGraph | undefined,
  parentId: string,
  level: string,
): number {
  if (!staged) return 0;
  let count = 0;
  for (const node of staged.nodes.values()) {
    if (node.level === level && node.constrainedBy.includes(parentId)) count += 1;
  }
  return count;
}

function removalQuestion(
  node: SourceCanonicalNode | undefined,
  term: SourceTermNode | undefined,
  staged: KnowledgeGraph | undefined,
): string | undefined {
  // The reader must see what is being destroyed without checking out a file
  // that no longer exists, so the question always carries the text verbatim.
  if (term) return `Withdraw this term? *${term.name}* — "${term.definition}"`;
  if (!node) return undefined;
  const parents = [...node.constrainedBy].sort();
  const remaining = parents
    .map((parentId) => {
      const count = remainingChildren(staged, parentId, node.level);
      return `under ${parentId}, ${count} other ${node.level} node(s) remain`;
    })
    .join("; ");
  const claim = `Withdraw this claim? "${node.statement}"`;
  return remaining.length > 0 ? `${claim} ${remaining[0]!.toUpperCase()}${remaining.slice(1)}.` : claim;
}

/**
 * PL2108, PL2109, and PL2110: what left the graph, what merely moved, and what
 * a parent lost while the child lives on. Warnings and info in the spirit of
 * PL2107 — the commit path reports them and blocks nothing; the enforced half
 * (the trailer record) lives with the message check.
 */
export function deletionDiagnostics(
  classification: DeletionClassification,
  head: KnowledgeGraph | undefined,
  staged: KnowledgeGraph | undefined,
  headTerms: SourceTermNode[],
  stagedTerms: SourceTermNode[],
  config: ResolvedConfig,
): Diagnostic[] {
  const headTermsById = new Map(headTerms.map((term) => [term.id, term]));
  const stagedTermsById = new Map(stagedTerms.map((term) => [term.id, term]));
  const diagnostics: Diagnostic[] = [];

  for (const id of classification.removals) {
    const node = head?.nodes.get(id);
    const term = headTermsById.get(id);
    diagnostics.push({
      code: "PL2108 NODE_REMOVED",
      severity: "warning",
      message: `${id} is deleted, and nothing staged replaces it.`,
      nodeId: id,
      path: node?.sourcePath ?? term?.sourcePath,
      action: "ask-user",
      infer: false,
      question: removalQuestion(node, term, staged),
      details: {
        ...(node ? { statement: node.statement, parents: [...node.constrainedBy].sort() } : {}),
        ...(term ? { name: term.name, definition: term.definition } : {}),
        suggestedTrailer: `${config.commit.removedTrailer}: ${id}`,
      },
    });
  }

  for (const pair of classification.renames) {
    const deletedNode = head?.nodes.get(pair.deletedId);
    const deletedTerm = headTermsById.get(pair.deletedId);
    const addedNode = staged?.nodes.get(pair.addedId);
    const addedTerm = stagedTermsById.get(pair.addedId);
    // The two mistakes are not the same size: a false removal adds one line
    // and one question, a false rename suppresses the removal warning and the
    // loss goes silent. So severity follows the kind of evidence. A statement
    // pair carries textual proof and reads as a note; a parents pair rests on
    // placement plus a shared word — an unrelated addition under the same
    // parents can meet that bar — so it is a question, not a note.
    const weak = pair.basis === "parents";
    diagnostics.push({
      code: "PL2109 NODE_RENAMED",
      severity: weak ? "warning" : "info",
      message: `${pair.deletedId} is deleted, and ${pair.addedId} appears to restate its claim.`,
      nodeId: pair.deletedId,
      path: addedNode?.sourcePath ?? addedTerm?.sourcePath,
      action: weak ? "ask-user" : "inspect",
      ...(weak ? { infer: false } : {}),
      details: {
        deleted: {
          id: pair.deletedId,
          ...(deletedNode ? { statement: deletedNode.statement } : {}),
          ...(deletedTerm ? { definition: deletedTerm.definition } : {}),
        },
        added: {
          id: pair.addedId,
          ...(addedNode ? { statement: addedNode.statement } : {}),
          ...(addedTerm ? { definition: addedTerm.definition } : {}),
        },
        similarity: Number(pair.similarity.toFixed(2)),
        basis: pair.basis,
        suggestedTrailer: `${config.commit.renamedTrailer}: ${pair.deletedId} -> ${pair.addedId}`,
      },
    });
  }

  diagnostics.push(...coverageDiagnostics(classification, head, staged));
  return diagnostics;
}

/**
 * PL2110: a node left its parent while staying in the graph — the re-parent
 * that quietly abandons a problem. Deleted children are PL2108's event and are
 * excluded, so the two never double-fire. Counts are useless here (a sweep
 * replaces what it deletes and the count holds still); only edge identity
 * detects, and both edge ends follow their rename successors so a pure rename
 * never fires. A constrainedBy entry that is not a staged node — a deleted and
 * unreplaced parent, or an audience wildcard — is skipped: the former is its
 * own PL2108, the latter is audience narrowing, not coverage.
 */
function coverageDiagnostics(
  classification: DeletionClassification,
  head: KnowledgeGraph | undefined,
  staged: KnowledgeGraph | undefined,
): Diagnostic[] {
  if (!head || !staged) return [];
  const successor = new Map<string, string>();
  for (const id of staged.nodes.keys()) successor.set(id, id);
  for (const pair of classification.renames) successor.set(pair.deletedId, pair.addedId);

  const diagnostics: Diagnostic[] = [];
  for (const child of [...head.nodes.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  )) {
    const childNow = successor.get(child.id);
    if (!childNow) continue;
    const stagedChild = staged.nodes.get(childNow);
    if (!stagedChild) continue;
    for (const parentId of [...child.constrainedBy].sort()) {
      const parentNow = successor.get(parentId);
      if (!parentNow) continue;
      const stagedParent = staged.nodes.get(parentNow);
      if (!stagedParent) continue;
      if (stagedChild.constrainedBy.includes(parentNow)) continue;
      const renamed = childNow !== child.id;
      diagnostics.push({
        code: "PL2110 COVERAGE_NARROWED",
        severity: "warning",
        message: renamed
          ? `${parentNow} lost ${child.id}; its successor ${childNow} no longer answers it.`
          : `${parentNow} lost ${childNow}, which is still in the graph and no longer answers it.`,
        nodeId: parentNow,
        path: stagedParent.sourcePath,
        action: "inspect",
        details: {
          parent: parentNow,
          child: childNow,
          childPath: stagedChild.sourcePath,
          beforeParents: [...child.constrainedBy].sort(),
          afterParents: [...stagedChild.constrainedBy].sort(),
        },
      });
    }
  }
  return diagnostics;
}
