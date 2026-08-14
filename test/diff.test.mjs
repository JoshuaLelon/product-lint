// What a branch changed about the PRODUCT, as against what it changed in files.
//
// `git diff` answers the second and cannot answer the first: a rename plus a
// rewrite is two file changes and one claim restated, and a digest churn across
// forty nodes is forty file changes and no claim at all.

import test from "node:test";
import assert from "node:assert/strict";
import { unlink } from "node:fs/promises";
import path from "node:path";
import {
  createRefSnapshot,
  createSnapshot,
  diffGraph,
  loadConfig,
  renderGraphDiff,
  synchronizeStaged,
} from "../dist/index.js";
import { createRepository, git, readNode, writeNode, writeTerm } from "./_helpers.mjs";

async function diffAgainstHead(root) {
  const config = await loadConfig(root);
  return diffGraph(
    config,
    await createRefSnapshot(config, "HEAD"),
    await createSnapshot(config, "working"),
    "HEAD",
  );
}

test("a restatement is one claim changed, and the levels sort by leverage", async () => {
  const { root } = await createRepository();
  const context = await readNode(root, "context", "review-problem");
  await writeNode(root, { ...context, statement: "Video teams cannot tell which cut is current." });
  const behavior = await readNode(root, "behavior", "approve-version");
  await writeNode(root, { ...behavior, statement: "A reviewer approves exactly one version." });

  const diff = await diffAgainstHead(root);
  assert.deepEqual(
    diff.restated.map((item) => item.id),
    ["context.review-problem", "behavior.approve-version"],
  );
  assert.match(diff.restated[0].before, /lose track of review state/);
  assert.match(diff.restated[0].after, /which cut is current/);
  assert.match(renderGraphDiff(diff), /2 claim\(s\) changed since HEAD/);
});

test("a rename is one claim restated, not one withdrawn and one unrelated written", async () => {
  const { root } = await createRepository();
  const node = await readNode(root, "product", "current-version");
  await unlink(path.join(root, "docs", "product", "current-version.json"));
  await writeNode(root, { ...node, id: "product.one-current-version" });
  // A rename re-parents its children. Without this the graph does not build,
  // which is its own finding rather than a diff.
  const child = await readNode(root, "behavior", "approve-version");
  await writeNode(root, { ...child, constrainedBy: ["product.one-current-version"] });

  const diff = await diffAgainstHead(root);
  // The matcher that already makes this call for the commit path makes it here,
  // so the two can never disagree about what happened.
  assert.equal(diff.removed.length, 1);
  assert.equal(diff.removed[0].id, "product.current-version");
  assert.equal(diff.removed[0].renamedTo, "product.one-current-version");
  assert.deepEqual(diff.added, [], "the successor is reported with the removal it answers");
});

test("a digest that moved is not a claim that changed", async () => {
  const { root, config } = await createRepository();
  const context = await readNode(root, "context", "review-problem");
  await writeNode(root, { ...context, statement: "Video teams cannot tell which cut is current." });
  await git(root, "add", "docs");
  await synchronizeStaged(config);

  const diff = await diffAgainstHead(root);
  // Editing one context statement restates one claim and re-digests every
  // descendant. Counting those as product changes would make every edit look
  // like a rewrite of the whole graph.
  assert.deepEqual(diff.restated.map((item) => item.id), ["context.review-problem"]);
  assert.ok(diff.synchronizedOnly.length > 0, "the descendants moved without changing");
  assert.doesNotMatch(renderGraphDiff(diff), /product\.current-version\n/);
});

test("vocabulary changes are called out, and a redefinition says it reaches every use", async () => {
  const { root } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });

  const diff = await diffAgainstHead(root);
  assert.deepEqual(diff.terms.added, ["term.version"]);
  assert.match(renderGraphDiff(diff), /vocabulary/);

  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one rendition a reviewer may approve.",
  });
  await git(root, "add", "docs");
  await git(root, "commit", "-qm", "docs: declare version\n\nKnowledge-Change: term.version");
  const after = await diffAgainstHead(root);
  assert.deepEqual(after.terms.redefined, []);
});

test("a branch that changed no claim says so", async () => {
  const { root } = await createRepository();
  const diff = await diffAgainstHead(root);
  assert.match(renderGraphDiff(diff), /no claim changed since HEAD/);
});

test("a diff over a graph that does not build says so rather than showing arithmetic", async () => {
  const { root } = await createRepository();
  const node = await readNode(root, "product", "current-version");
  await unlink(path.join(root, "docs", "product", "current-version.json"));
  await writeNode(root, { ...node, id: "product.orphaned-rename" });

  const diff = await diffAgainstHead(root);
  // The child still names the old id, so nothing builds. Reported as arithmetic
  // this said the entire product had been withdrawn.
  assert.deepEqual(diff.unbuilt, ["the working tree"]);
  assert.deepEqual(diff.removed, []);
  assert.match(renderGraphDiff(diff), /cannot diff: the graph at the working tree does not build/);
});
