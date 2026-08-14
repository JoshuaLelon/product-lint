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
  clusterDirectories,
  createSnapshot,
  hasErrors,
  inspectWorkingTree,
  loadConfig,
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
  const draft = status.frontier.diagnostics.find((item) => item.code === "PL0901 DRAFT_NODE");
  assert.ok(draft, "a placeholder is the most visible thing in the report");
  assert.equal(draft.severity, "info");
  // Shallowest level first, because that is the order of leverage: sorted by id
  // instead, architecture came out on top of the report.
  assert.deepEqual(
    draft.details.drafts.map((group) => group.level),
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
