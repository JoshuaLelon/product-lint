// adopt: give unowned files an owner without inventing a claim.
//
// The alternative it replaces is a blocked commit — PL2101 refuses an edit to a
// file no Mechanism owns, and the repair reaches all the way up to a problem
// that may not exist. So a draft spine is written instead: the logistics pass at
// once, and what is missing is exactly one thing per node, a sentence.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  adopt,
  buildKnowledgeGraph,
  classifyDeletions,
  classifyNodeChanges,
  clusterDirectories,
  createSnapshot,
  hasErrors,
  inspectWorkingTree,
  loadConfig,
  orderedObligations,
  placeholderStatement,
  validateSnapshot,
} from "../dist/index.js";
import { createRepository, git } from "./_helpers.mjs";

async function addSource(root, files) {
  for (const file of files) {
    const full = path.join(root, file);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, "export const x = 1;\n", "utf8");
  }
  await git(root, "add", ".");
}

async function runAdopt(root, targets = []) {
  const config = await loadConfig(root);
  const snapshot = await createSnapshot(config, "working");
  const validation = await validateSnapshot(config, snapshot);
  return adopt(config, validation.graph, snapshot, targets);
}

test("clusters are modules, neither one trunk nor one spine per file", () => {
  const unowned = [
    "src/billing/retry.ts",
    "src/billing/invoice.ts",
    "src/retrieval/rank/score.ts",
    "src/retrieval/index.ts",
  ];
  // One spine per file is thousands of placeholders; one for the whole tree is
  // a single trunk, and the point of drafting bottom-up is to SEE what problems
  // the code implies. A graph with one problem says nothing to revise.
  assert.deepEqual(clusterDirectories(unowned, [], ["src"]), ["src/billing", "src/retrieval"]);
  // A module holding a file a real Mechanism owns is split finer, so a
  // generated glob never reaches across an existing claim.
  assert.deepEqual(
    clusterDirectories(["src/billing/retry.ts"], ["src/billing/invoice.ts"], ["src"]),
    ["src/billing"],
  );
});

test("a spine makes the file committable and owes a statement per node", async () => {
  const { root } = await createRepository();
  await addSource(root, ["src/billing/retry.ts", "src/retrieval/rank.ts"]);

  const result = await runAdopt(root);
  assert.deepEqual(
    result.clusters.map((cluster) => cluster.directory),
    ["src/billing", "src/retrieval"],
  );
  // One audience for the repository, not one per module: writing one per
  // cluster would state that src/billing serves different people than
  // src/retrieval, which adopt has no basis for.
  const ids = result.clusters.flatMap((cluster) => cluster.nodes);
  assert.equal(ids.filter((id) => id.startsWith("audience.")).length, 1);
  assert.equal(ids.includes("audience.draft"), true);
  assert.equal(result.written.length, 11, "one shared audience plus five per module");

  await git(root, "add", "docs");
  const status = await inspectWorkingTree(await loadConfig(root));
  // The logistics are genuinely satisfied — every node has a parent, every file
  // has an owner — so nothing here is an error.
  assert.equal(hasErrors(status.validation.diagnostics), false);
  assert.equal(
    status.frontier.diagnostics.some((item) => item.code.startsWith("PL0601")),
    false,
    "the files have owners now",
  );
});

test("ship refuses while a draft remains, and check does not", async () => {
  const { root } = await createRepository();
  await addSource(root, ["src/billing/retry.ts"]);
  await runAdopt(root);
  await git(root, "add", "docs");

  const status = await inspectWorkingTree(await loadConfig(root));
  const drafts = status.frontier.diagnostics.filter((item) => item.code === "PL0901 DRAFT_NODE");
  assert.equal(drafts.length, 6, "one obligation per placeholder, not one row for all of them");
  assert.equal(drafts[0].severity, "info");
  // A draft IS a frontier obligation: a missing node owes existence, a draft
  // owes a statement, and both are answered by reading the level and the terms
  // and answering the level's question. So it carries the same work order.
  const audience = drafts.find((item) => item.requiredLevel === "audience");
  assert.equal(audience.frontier, "audience.draft");
  assert.match(audience.question, /Who is this product for/);
  assert.ok(audience.details.level, "the siblings to read before writing a duplicate");
  assert.deepEqual(
    orderedObligations(drafts).map((item) => item.requiredLevel),
    ["audience", "context", "product", "behavior", "architecture", "mechanism"],
  );
  // Not done. `ship` means terminal completeness, and file bindings under
  // statements nobody has made are not that.
  assert.equal(status.frontier.complete, false);
});

test("a written draft that kept its flag is named, so ship is not held for finished work", async () => {
  const { root } = await createRepository();
  await addSource(root, ["src/billing/retry.ts"]);
  await runAdopt(root);

  const file = path.join(root, "docs", "context", "draft-src-billing.json");
  const node = JSON.parse(await readFile(file, "utf8"));
  assert.equal(node.statement, placeholderStatement("context"));
  node.statement = "Finance teams lose track of which invoices were retried.";
  await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  await git(root, "add", "docs");

  const status = await inspectWorkingTree(await loadConfig(root));
  const stale = status.frontier.diagnostics.find(
    (item) => item.code === "PL0902 DRAFT_LOOKS_WRITTEN",
  );
  // The one hole a separate field opens that a marker string does not.
  assert.ok(stale, "a draft whose statement nobody generated has been written");
  assert.match(stale.message, /Drop the flag/);
});

test("adopt never overwrites a node someone wrote", async () => {
  const { root } = await createRepository();
  await addSource(root, ["src/billing/retry.ts"]);
  await runAdopt(root);

  const file = path.join(root, "docs", "mechanism", "draft-src-billing.json");
  const node = JSON.parse(await readFile(file, "utf8"));
  delete node.draft;
  node.statement = "A retry command owns invoice retries.";
  await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
  await git(root, "add", "docs");

  const again = await runAdopt(root);
  assert.deepEqual(again.clusters, [], "a promoted spine is left alone");
  assert.equal(
    JSON.parse(await readFile(file, "utf8")).statement,
    "A retry command owns invoice retries.",
    "the one way this command could destroy knowledge rather than owe it",
  );
});

test("a governed root with no directories under it is named as one coarse cluster", async () => {
  const { root } = await createRepository();
  await addSource(root, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  const result = await runAdopt(root);
  // The clustering is still right: inventing boundaries a flat tree does not
  // declare would be adopt guessing at product structure. What was missing is
  // saying so, because a reader who is not told the spine is coarse reads one
  // problem as the answer.
  assert.deepEqual(result.clusters.map((cluster) => cluster.directory), ["src"]);
  assert.deepEqual(result.flatRoots, [{ root: "src", files: 3 }]);
});

test("a root with real modules is not called flat, even when files sit beside them", async () => {
  const { root } = await createRepository();
  await addSource(root, ["src/loose.ts", "src/billing/retry.ts", "src/retrieval/rank.ts"]);
  const result = await runAdopt(root);
  // `src` is a cluster here too — the leftovers — but it is not the only one,
  // so the tree did declare boundaries and there is nothing to warn about.
  assert.equal(result.clusters.length, 3);
  assert.deepEqual(result.flatRoots, []);
});

// --- Drafts are outside the trailer economy ---
//
// A draft's statement is the sentence adopt generated; it says TODO. Demanding a
// declaration for creating one asks an author to declare a decision they have
// explicitly not made, and adopting a repository cost a trailer per placeholder
// — on the first commit, more trailers for scaffolding than for the claims
// beside it, which is the day-one cost adopt exists to remove.

const ROOT = {
  id: "audience.role.engineer",
  level: "audience",
  statement: "The product serves the engineer who writes the code.",
  constrainedBy: [],
};

/** Every context node needs an audience parent, so the root rides along. */
function graphOf(nodes) {
  return buildKnowledgeGraph(
    [ROOT, ...nodes].map((node) => ({
      schemaVersion: 1,
      constrainedBy: node.level === "audience" ? [] : [ROOT.id],
      sync: { constraintsDigest: "pending" },
      ...node,
      sourcePath: `docs/${node.level}/${node.id.split(".").slice(1).join("-")}.json`,
    })),
  ).graph;
}

const PLACEHOLDER = placeholderStatement("context");

test("writing, moving, and deleting a draft declares nothing", () => {
  const draft = { id: "context.draft-src", level: "context", statement: PLACEHOLDER, draft: true };
  const empty = graphOf([]);

  // Written by adopt.
  const added = classifyNodeChanges(empty, graphOf([draft]));
  assert.deepEqual([...added.semantic], []);
  assert.deepEqual([...added.added], [], "an addition nobody claimed is not a claim added");
  // Still tracked, so the file must be staged and PL2102 still fires: what is
  // waived is the declaration, not the bookkeeping.
  assert.deepEqual([...added.synchronizationOnly], ["context.draft-src"]);
  assert.equal(added.changedPaths.get("context.draft-src"), "docs/context/draft-src.json");

  // Re-parented while a real audience layer is written above it.
  const moved = classifyNodeChanges(
    graphOf([{ ...draft, constrainedBy: [ROOT.id] }]),
    graphOf([{ ...draft, constrainedBy: [ROOT.id, "audience.role.engineer"] }]),
  );
  assert.deepEqual([...moved.semantic], []);

  // Deleted, because the one placeholder became nine real problems.
  const removed = classifyNodeChanges(graphOf([draft]), empty);
  assert.deepEqual([...removed.semantic], []);
  assert.deepEqual([...removed.deleted], [], "withdrawing nothing is not a removal");
});

test("promotion is the moment a claim is made, and demotion the moment one is withdrawn", () => {
  const draft = { id: "context.slow", level: "context", statement: PLACEHOLDER, draft: true };
  const written = {
    id: "context.slow",
    level: "context",
    statement: "An engineer waits on a build they cannot skip.",
  };

  const promoted = classifyNodeChanges(graphOf([draft]), graphOf([written]));
  assert.deepEqual([...promoted.semantic], ["context.slow"]);

  // Both sides are read, not just the staged one: turning a written node back
  // into a placeholder withdraws a claim.
  const demoted = classifyNodeChanges(graphOf([written]), graphOf([draft]));
  assert.deepEqual([...demoted.semantic], ["context.slow"]);
});

test("a draft replaced by real nodes is not mistaken for a rename", () => {
  const draft = { id: "context.draft-src", level: "context", statement: PLACEHOLDER, draft: true };
  const real = [
    { id: "context.a", level: "context", statement: "An engineer cannot find the governing decision." },
    { id: "context.b", level: "context", statement: "An engineer repeats a claim known to be wrong." },
  ];
  const changes = classifyNodeChanges(graphOf([draft]), graphOf(real));
  // classifyDeletions pairs deletions against additions by similarity. A draft
  // that never entered `deleted` cannot be paired with either successor, so the
  // promotion reads as two claims added rather than one restated plus one new.
  const deletions = classifyDeletions(graphOf([draft]), graphOf(real), [], [], changes);
  assert.deepEqual(deletions.renames, []);
  assert.deepEqual(deletions.removals, []);
  assert.deepEqual([...changes.semantic].sort(), ["context.a", "context.b"]);
});
