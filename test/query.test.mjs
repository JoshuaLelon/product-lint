import test from "node:test";
import assert from "node:assert/strict";
import { affectedByNode, buildKnowledgeGraph, knowledgeForFile } from "../dist/index.js";
import { canonicalNodes } from "./_helpers.mjs";

function source(node) {
  return { ...node, sourcePath: `docs/${node.level}/${node.id}.json` };
}

const graph = buildKnowledgeGraph(canonicalNodes().map(source)).graph;
const snapshot = {
  kind: "working",
  files: ["src/approve.ts", "test/approve.test.ts"],
  hasFile: () => true,
  readFile: async () => "",
};

test("finds the full lineage for a governed file", () => {
  const result = knowledgeForFile(graph, [], "src/approve.ts");
  assert.deepEqual(result.lineage.map((node) => node.id), [
    "audience.role.reviewer",
    "context.review-problem",
    "product.current-version",
    "behavior.approve-version",
    "architecture.approval-owner",
    "mechanism.approval-command",
  ]);
});

test("finds downstream nodes and files affected by a product node", () => {
  const result = affectedByNode(graph, [], snapshot, "product.current-version");
  assert.deepEqual(result.files, ["src/approve.ts", "test/approve.test.ts"]);
  assert.ok(result.descendants.some((node) => node.id === "mechanism.approval-command"));
});
