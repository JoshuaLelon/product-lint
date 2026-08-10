// Two ways of answering the same question must agree.
//
// "Which governed files have no Mechanism owner" is derived twice, by two
// functions that do not call each other: the frontier filters governed files by
// a predicate, and `knowledgeForFile` selects nodes by the same predicate. They
// agree today because both spell it the same way, and nothing enforces that.
//
// A downstream consumer can use the disagreement as a self-check — if the
// frontier says every file is owned and the query names an owner for none, both
// cannot be true, and the half that is wrong is the reading rather than the
// data. That check is only sound while the two stay in step, so the contract is
// written down here rather than left to coincidence.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  createSnapshot,
  detectFrontier,
  governedFiles,
  knowledgeForFile,
  loadConfig,
  validateSnapshot,
} from "../dist/index.js";
import { createRepository, writeNode } from "./_helpers.mjs";

/** The unowned set, derived independently by each path. */
async function unownedTwoWays(root) {
  const config = await loadConfig(root);
  const snapshot = await createSnapshot(config, "working");
  const validation = await validateSnapshot(config, snapshot);
  assert.ok(validation.graph, "fixture must build a graph");
  const frontier = detectFrontier(config, validation.graph, snapshot);

  const reported = new Set();
  for (const diagnostic of frontier.diagnostics) {
    if (diagnostic.code === "PL0601 UNMAPPED_FILE") reported.add(diagnostic.path);
    if (diagnostic.code === "PL0602 UNGOVERNED_TREE") {
      for (const file of diagnostic.details.files) reported.add(file);
    }
  }

  const unnameable = governedFiles(config, snapshot).filter(
    (file) =>
      knowledgeForFile(validation.graph, validation.references, file).mechanisms.length === 0,
  );

  return {
    complete: frontier.complete,
    reported: [...reported].sort(),
    unnameable: [...unnameable].sort(),
  };
}

async function addFiles(root, files) {
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "// file\n");
  }
}

test("a fully owned graph reports no unowned files by either path", async () => {
  const { root } = await createRepository();
  const { complete, reported, unnameable } = await unownedTwoWays(root);
  assert.equal(complete, true);
  assert.deepEqual(reported, []);
  assert.deepEqual(unnameable, []);
});

// The load-bearing case. Two empty sets are equal for free, so the contract is
// only actually tested where both sets have members.
test("the two paths name the same files, and the set is not empty", async () => {
  const { root } = await createRepository();
  await addFiles(root, ["src/alpha.ts", "src/nested/beta.ts", "test/gamma.test.ts"]);
  const { complete, reported, unnameable } = await unownedTwoWays(root);

  assert.equal(complete, false);
  assert.ok(unnameable.length > 0, "the case must exercise a non-empty set");
  assert.deepEqual(reported, unnameable);
  assert.deepEqual(unnameable, ["src/alpha.ts", "src/nested/beta.ts", "test/gamma.test.ts"]);
});

test("the two paths agree through globs, braces, and nested wildcards", async () => {
  const { root } = await createRepository();
  await addFiles(root, [
    "src/wide/one.ts",
    "src/wide/deep/two.ts",
    "src/pick/chosen.ts",
    "src/pick/ignored.ts",
    "src/orphan/three.ts",
  ]);
  await writeNode(root, {
    id: "mechanism.wide",
    level: "mechanism",
    statement: "The wide node owns a subtree.",
    constrainedBy: ["architecture.approval-owner"],
    sync: { constraintsDigest: "pending" },
    implementation: { files: ["src/wide/**", "src/pick/{chosen}.ts"], digest: "pending" },
  });

  const { reported, unnameable } = await unownedTwoWays(root);
  // Whatever the glob engine decides, both readings must decide it identically.
  assert.deepEqual(reported, unnameable);
  assert.deepEqual(unnameable, ["src/orphan/three.ts", "src/pick/ignored.ts"]);
});

test("a graph too shallow to own anything still agrees", async () => {
  // No Architecture level, so the frontier collapses every unowned file into a
  // single PL0602 carrying the list, instead of one PL0601 each. The shape of
  // the report changes; the set it describes must not.
  const { root } = await createRepository();
  await addFiles(root, ["src/one.ts", "src/two.ts"]);
  const config = await loadConfig(root);
  const snapshot = await createSnapshot(config, "working");
  const validation = await validateSnapshot(config, snapshot);
  const frontier = detectFrontier(config, validation.graph, snapshot);
  const collapsed = frontier.diagnostics.find((item) => item.code === "PL0602 UNGOVERNED_TREE");
  const perFile = frontier.diagnostics.filter((item) => item.code === "PL0601 UNMAPPED_FILE");
  assert.ok(collapsed || perFile.length > 0, "one shape or the other must report them");

  const { reported, unnameable } = await unownedTwoWays(root);
  assert.deepEqual(reported, unnameable);
});

// The consumer-facing form, derived from the equality above.
test("a complete frontier means every governed file can name an owner", async () => {
  const { root } = await createRepository();
  const { complete, unnameable } = await unownedTwoWays(root);
  if (complete) assert.deepEqual(unnameable, [], "complete must imply every file resolves");
});
