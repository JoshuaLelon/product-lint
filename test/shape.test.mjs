// The rules that decide what a node IS, delivered where an agent will read them.
//
// These exist because the rules are not obvious and an agent that does not know
// them writes the two things they forbid: a node that states two claims, and a
// second node saying what a sibling already says. Both read correct alone.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  annotateDiagnostic,
  AUDIENCE_SHAPE,
  buildKnowledgeGraph,
  inspectWorkingTree,
  formatDiagnostic,
  loadConfig,
  renderFileKnowledgeForLlm,
  knowledgeForFile,
  NODE_SHAPE,
  STATEMENT_STYLE,
} from "../dist/index.js";
import { canonicalNodes, createRepository, git, writeNode } from "./_helpers.mjs";

test("the one-thing rule rides the statement style", () => {
  assert.match(STATEMENT_STYLE, /State one thing/);
  assert.match(
    STATEMENT_STYLE,
    /two claims that can be false independently/,
    "the test for 'one thing' must be stated, not just the instruction",
  );
});

test("the shape rule says to add a parent rather than a second node", () => {
  assert.match(NODE_SHAPE, /do not overlap/);
  assert.match(NODE_SHAPE, /cover the level/, "the CE half of MECE, not only the ME half");
  assert.match(NODE_SHAPE, /do not write a second node/);
  assert.match(NODE_SHAPE, /constrainedBy/, "it must name the field that fixes it");
  assert.match(NODE_SHAPE, /many parents/);
});

test("the shape rule is not folded into the style rule", () => {
  // They are delivered together but stay separate: one is checkable by reading a
  // sentence, the other only by reading the level. Merging them makes both vague.
  assert.doesNotMatch(STATEMENT_STYLE, /constrainedBy/);
  assert.doesNotMatch(NODE_SHAPE, /ASD-STE100/);
});

for (const code of [
  "PL0001 MISSING_CONTEXT",
  "PL0101 MISSING_PRODUCT",
  "PL0201 MISSING_BEHAVIOR",
  "PL0301 MISSING_ARCHITECTURE",
  "PL0401 MISSING_MECHANISM",
  "PL1009 MISSING_STATEMENT",
]) {
  test(`${code} carries the shape rule`, () => {
    const annotated = annotateDiagnostic({ code, severity: "info", message: "x" });
    assert.equal(annotated.shape, NODE_SHAPE, "this diagnostic is about to add a node");
  });
}

test("the audience level takes its own shape rule, because it is n sets and not one", () => {
  const annotated = annotateDiagnostic({
    code: "PL0011 MISSING_AUDIENCE",
    severity: "info",
    message: "x",
  });
  assert.equal(annotated.shape, AUDIENCE_SHAPE);
  assert.notEqual(annotated.shape, NODE_SHAPE);
});

test("the audience rule does not carry advice that cannot apply to a parentless node", () => {
  // The general rule's repair for a duplicate is "add your parent to its
  // constrainedBy instead". Audience nodes have no parents, so that sentence
  // would send an agent to do something the level forbids.
  assert.match(NODE_SHAPE, /Add your parent to its constrainedBy/);
  assert.doesNotMatch(AUDIENCE_SHAPE, /Add your parent to its constrainedBy/);
  // And it must say the thing the general rule cannot: one node per combination
  // is the shape this level exists to avoid.
  assert.match(AUDIENCE_SHAPE, /Do not write one node per combination/);
});

test("a diagnostic that adds no node carries no shape rule", () => {
  // PL2101 is about a file with no owner, not about authoring a node, and a rule
  // printed everywhere is a rule nobody reads.
  const annotated = annotateDiagnostic({
    code: "PL2101 UNMAPPED_STAGED_FILE",
    severity: "error",
    message: "x",
  });
  assert.equal(annotated.shape, undefined);
});

test("the llms view carries both rules", () => {
  // This view is a SLICE — it shows a lineage, never the level — so it is the
  // exact position from which a duplicate sibling gets written.
  const graph = buildKnowledgeGraph(
    canonicalNodes().map((node) => ({ ...node, sourcePath: `docs/${node.level}/${node.id}.json` })),
  ).graph;
  const text = renderFileKnowledgeForLlm(knowledgeForFile(graph, [], "src/approve.ts"));
  assert.match(text, /If you write or edit a statement/);
  assert.match(text, /If you add a node/);
  assert.match(text, /do not write a second node/);
});

test("the frontier prints the shape rule to a real repository", async () => {
  const { root, config } = await createRepository();
  await mkdir(path.join(root, "docs", "context"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "context", "second.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "context.second",
        level: "context",
        statement: "A second context with no product below it.",
        constrainedBy: ["audience.role.reviewer"],
        sync: { constraintsDigest: "pending" },
      },
      null,
      2,
    )}\n`,
  );
  await git(root, "add", "docs");

  const status = await inspectWorkingTree(config);
  const missingProduct = status.frontier.diagnostics
    .map(annotateDiagnostic)
    .find((item) => item.code.startsWith("PL0101"));
  assert.ok(missingProduct, "a childless context is a product frontier");
  assert.match(missingProduct.shape, /do not overlap/);
});

// The shape rule says to read the level before adding to it. These assert the
// level actually arrives with the rule, because a rule about a set the reader
// cannot see is advice, not information.

test("a diagnostic that adds a node shows the nodes already at that level", async () => {
  const { root } = await createRepository();
  for (const [id, statement] of [
    ["behavior.reject-version", "A reviewer can reject the current version."],
    ["behavior.comment-version", "A reviewer can comment on the current version."],
  ]) {
    await writeNode(root, {
      id,
      level: "behavior",
      statement,
      constrainedBy: ["product.current-version"],
      sync: { constraintsDigest: "pending" },
    });
  }
  await writeNode(root, {
    id: "product.second-rule",
    level: "product",
    statement: "A second product rule with nothing under it yet.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });

  const status = await inspectWorkingTree(await loadConfig(root));
  const missing = status.frontier.diagnostics.find(
    (item) => item.code === "PL0201 MISSING_BEHAVIOR",
  );
  assert.ok(missing, "the frontier must ask for the missing behavior");
  assert.equal(missing.details.level.total, 3);
  assert.deepEqual(
    missing.details.level.shown.map((node) => node.id),
    ["behavior.approve-version", "behavior.comment-version", "behavior.reject-version"],
  );
  // The statements are the point. Ids alone do not show a duplicate.
  assert.ok(missing.details.level.shown.every((node) => node.statement.length > 0));

  const text = formatDiagnostic(missing);
  assert.match(text, /behavior already has \(3\):/);
  assert.match(text, /A reviewer can reject the current version\./);
});

test("an empty level is not announced", async () => {
  const { root } = await createRepository();
  await writeNode(root, {
    id: "architecture.second-owner",
    level: "architecture",
    statement: "A second architecture node with no mechanism under it.",
    constrainedBy: ["behavior.approve-version"],
    sync: { constraintsDigest: "pending" },
  });
  const status = await inspectWorkingTree(await loadConfig(root));
  const missing = status.frontier.diagnostics.find(
    (item) => item.code === "PL0401 MISSING_MECHANISM",
  );
  assert.ok(missing);
  assert.equal(missing.details.level.total, 1);
  const empty = { ...missing, details: { level: { total: 0, shown: [] } } };
  assert.doesNotMatch(formatDiagnostic(empty), /already has/);
});

test("a long level states how much it did not show", () => {
  const shown = Array.from({ length: 20 }, (_, index) => ({
    id: `behavior.node-${index}`,
    statement: `Statement number ${index}.`,
  }));
  const text = formatDiagnostic({
    code: "PL0201 MISSING_BEHAVIOR",
    severity: "info",
    message: "x has no direct behavior descendant.",
    requiredLevel: "behavior",
    details: { level: { total: 33, shown } },
  });
  assert.match(text, /behavior already has \(33\):/);
  // Silence about a truncation reads as a complete list.
  assert.match(text, /\.\.\. and 13 more not shown/);
});
