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
  buildKnowledgeGraph,
  inspectWorkingTree,
  renderFileKnowledgeForLlm,
  knowledgeForFile,
  NODE_SHAPE,
  STATEMENT_STYLE,
} from "../dist/index.js";
import { canonicalNodes, createRepository, git } from "./_helpers.mjs";

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
        constrainedBy: [],
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
