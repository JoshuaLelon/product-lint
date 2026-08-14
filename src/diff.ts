import type {
  KnowledgeLevel,
  RepositorySnapshot,
  ResolvedConfig,
  SourceCanonicalNode,
} from "./types.js";
import { buildKnowledgeGraph, loadCanonicalNodes } from "./graph.js";
import { classifyNodeChanges } from "./commit.js";
import { levelIndex, loadTermNodes, semanticTermFingerprint } from "./terms.js";
import { classifyDeletions } from "./removal.js";

/**
 * What a branch changed about the PRODUCT, as against what it changed in files.
 *
 * `git diff` answers the second and cannot answer the first: a rename plus a
 * rewrite is two file changes and one claim restated, and a digest churn across
 * forty nodes is forty file changes and no claim at all. The commit path already
 * draws this distinction to decide which trailers are owed — `classifyNodeChanges`
 * separates semantic changes from synchronization — and it drew it only for the
 * staged diff, where the answer is used to refuse a commit rather than to be
 * read by anyone.
 *
 * A tool whose thesis is that decisions are stored so later decisions can use
 * them should be able to say which decisions a change made. This is that.
 */
export interface ClaimChange {
  id: string;
  level: KnowledgeLevel;
  before?: string;
  after?: string;
}

export interface GraphDiff {
  base: string;
  /** Claims that did not exist at the base. */
  added: ClaimChange[];
  /** Claims withdrawn, paired with a successor where one was found. */
  removed: (ClaimChange & { renamedTo?: string })[];
  /** Claims that still exist and now say something different. */
  restated: ClaimChange[];
  /** Nodes whose files changed with no change of meaning: digests, formatting. */
  synchronizedOnly: string[];
  terms: { added: string[]; removed: string[]; redefined: string[] };
  /**
   * Which side failed to build, if either did.
   *
   * A graph that does not build has no nodes to compare against, so every node
   * on the other side reads as added or withdrawn — a rename that forgot to
   * re-parent its children reported the entire product as deleted. The diff is
   * arithmetic over two graphs and is meaningless when one is absent, so it says
   * so instead of showing the arithmetic.
   */
  unbuilt: string[];
}

async function readGraph(config: ResolvedConfig, snapshot: RepositorySnapshot) {
  const loaded = await loadCanonicalNodes(config, snapshot);
  const terms = await loadTermNodes(config, snapshot);
  return {
    nodes: new Map(loaded.nodes.map((node) => [node.id, node])),
    graph: buildKnowledgeGraph(loaded.nodes).graph,
    terms: new Map(terms.terms.map((term) => [term.id, term])),
  };
}

function claim(node: SourceCanonicalNode, key: "before" | "after"): ClaimChange {
  return { id: node.id, level: node.level, [key]: node.statement };
}

/** Shallowest level first, then id. The leverage order used everywhere else. */
function byLevel<T extends { level: KnowledgeLevel; id: string }>(items: T[]): T[] {
  return [...items].sort(
    (left, right) => levelIndex(left.level) - levelIndex(right.level) || left.id.localeCompare(right.id),
  );
}

export async function diffGraph(
  config: ResolvedConfig,
  base: RepositorySnapshot,
  head: RepositorySnapshot,
  baseLabel: string,
): Promise<GraphDiff> {
  const before = await readGraph(config, base);
  const after = await readGraph(config, head);
  const unbuilt = [
    ...(before.graph ? [] : [baseLabel]),
    ...(after.graph ? [] : ["the working tree"]),
  ];
  if (unbuilt.length > 0) {
    return {
      base: baseLabel,
      added: [],
      removed: [],
      restated: [],
      synchronizedOnly: [],
      terms: { added: [], removed: [], redefined: [] },
      unbuilt,
    };
  }

  // Reused rather than reimplemented, so the diff and the commit path can never
  // disagree about what counts as a claim changing. A digest that moved is not
  // a claim that changed, and that judgement already lives in one place.
  const changes = classifyNodeChanges(before.graph, after.graph);
  const added: ClaimChange[] = [];
  const removedNodes: SourceCanonicalNode[] = [];
  const restated: ClaimChange[] = [];

  for (const id of [...changes.semantic].sort()) {
    const was = before.nodes.get(id);
    const is = after.nodes.get(id);
    if (!was && is) added.push(claim(is, "after"));
    else if (was && !is) removedNodes.push(was);
    else if (was && is) {
      restated.push({ id, level: is.level, before: was.statement, after: is.statement });
    }
  }
  const synchronizedOnly = [...changes.synchronizationOnly];

  // A removal paired with a successor is one claim restated under a new name,
  // not a claim withdrawn and an unrelated one written. The matcher that already
  // makes this call for the commit path makes it here.
  const deletions = classifyDeletions(
    before.graph,
    after.graph,
    [...before.terms.values()],
    [...after.terms.values()],
    changes,
  );
  const renamedTo = new Map(deletions.renames.map((pair) => [pair.deletedId, pair.addedId]));
  const removed = removedNodes.map((node) => ({
    ...claim(node, "before"),
    ...(renamedTo.has(node.id) ? { renamedTo: renamedTo.get(node.id)! } : {}),
  }));
  const renamedIds = new Set(deletions.renames.map((pair) => pair.addedId));

  const termIds = new Set([...before.terms.keys(), ...after.terms.keys()]);
  const terms = { added: [] as string[], removed: [] as string[], redefined: [] as string[] };
  for (const id of [...termIds].sort()) {
    const was = before.terms.get(id);
    const is = after.terms.get(id);
    if (!was && is) terms.added.push(id);
    else if (was && !is) terms.removed.push(id);
    else if (was && is && semanticTermFingerprint(was) !== semanticTermFingerprint(is)) {
      terms.redefined.push(id);
    }
  }

  return {
    base: baseLabel,
    // A node that arrived as the successor of a rename is reported with the
    // removal it answers, not a second time as new.
    added: byLevel(added.filter((item) => !renamedIds.has(item.id))),
    removed: byLevel(removed),
    restated: byLevel(restated),
    synchronizedOnly: synchronizedOnly.sort(),
    terms,
    unbuilt: [],
  };
}

export function renderGraphDiff(diff: GraphDiff): string {
  if (diff.unbuilt.length > 0) {
    return (
      `cannot diff: the graph at ${diff.unbuilt.join(" and ")} does not build.\n` +
      `  product-lint validate\n`
    );
  }
  const total = diff.added.length + diff.removed.length + diff.restated.length;
  const lines: string[] = [];
  if (total === 0 && diff.terms.added.length + diff.terms.removed.length + diff.terms.redefined.length === 0) {
    lines.push(
      `no claim changed since ${diff.base}.` +
        (diff.synchronizedOnly.length > 0
          ? ` ${diff.synchronizedOnly.length} node file(s) changed without changing a claim.`
          : ""),
    );
    return `${lines.join("\n")}\n`;
  }

  lines.push(`${total} claim(s) changed since ${diff.base} — shallowest level first`, "");
  const section = (title: string, items: ClaimChange[], mark: string) => {
    if (items.length === 0) return;
    lines.push(`  ${title} (${items.length})`);
    for (const item of items) {
      lines.push(`    ${mark} ${item.level.padEnd(12)} ${item.id}`);
      if (item.before) lines.push(`        was: ${item.before}`);
      if (item.after) lines.push(`        now: ${item.after}`);
      const successor = (item as { renamedTo?: string }).renamedTo;
      if (successor) lines.push(`        restated as: ${successor}`);
    }
    lines.push("");
  };
  section("added", diff.added, "+");
  section("withdrawn", diff.removed, "-");
  section("restated", diff.restated, "~");

  const { added, removed, redefined } = diff.terms;
  if (added.length + removed.length + redefined.length > 0) {
    lines.push("  vocabulary");
    if (added.length > 0) lines.push(`    + ${added.join(", ")}`);
    if (removed.length > 0) lines.push(`    - ${removed.join(", ")}`);
    // A redefinition reaches every statement that speaks the word, so it is
    // never a small change however small the edit looked.
    if (redefined.length > 0) lines.push(`    ~ ${redefined.join(", ")}   (reaches every use)`);
    lines.push("");
  }
  if (diff.synchronizedOnly.length > 0) {
    lines.push(`  ${diff.synchronizedOnly.length} node file(s) changed without changing a claim.`);
  }
  return `${lines.join("\n")}\n`;
}
