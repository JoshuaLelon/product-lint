import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeGraph } from "../dist/index.js";
import { canonicalNodes } from "./_helpers.mjs";

function source(node) {
  return { ...node, sourcePath: `docs/${node.level}/${node.id}.json` };
}

test("builds a valid continuous knowledge DAG", () => {
  const result = buildKnowledgeGraph(canonicalNodes().map(source));
  assert.equal(result.diagnostics.length, 0);
  assert.ok(result.graph);
  assert.deepEqual(result.graph.topologicalOrder, [
    "audience.role.reviewer",
    "context.review-problem",
    "product.current-version",
    "behavior.approve-version",
    "architecture.approval-owner",
    "mechanism.approval-command",
  ]);
});

test("rejects skipped levels and downward dependencies", () => {
  const nodes = canonicalNodes();
  nodes[3].constrainedBy = ["context.review-problem"];
  const result = buildKnowledgeGraph(nodes.map(source));
  const codes = new Set(result.diagnostics.map((item) => item.code));
  assert.ok(codes.has("PL1104 SKIPPED_KNOWLEDGE_LEVEL"));
});

test("rejects cycles", () => {
  const nodes = canonicalNodes();
  nodes[1].constrainedBy = ["context.second"];
  nodes.push({
    id: "context.second",
    level: "context",
    statement: "A second problem.",
    constrainedBy: ["context.review-problem", "audience.role.reviewer"],
    sync: { constraintsDigest: "pending" },
  });
  const result = buildKnowledgeGraph(nodes.map(source));
  assert.ok(result.diagnostics.some((item) => item.code === "PL1105 KNOWLEDGE_CYCLE"));
});
