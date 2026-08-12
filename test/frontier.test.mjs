import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeGraph, detectFrontier } from "../dist/index.js";
import { canonicalNodes } from "./_helpers.mjs";

const config = {
  governedPaths: { include: ["src/**", "test/**"], exclude: [] },
};

function snapshot(files) {
  return { kind: "working", files, hasFile: (file) => files.includes(file), readFile: async () => "" };
}

function source(node) {
  return { ...node, sourcePath: `docs/${node.level}/${node.id}.json` };
}

test("reports missing Context for an empty graph", () => {
  const graph = buildKnowledgeGraph([]).graph;
  const result = detectFrontier(config, graph, snapshot([]));
  assert.equal(result.complete, false);
  assert.equal(result.diagnostics[0].code, "PL0011 MISSING_AUDIENCE");
  assert.equal(result.diagnostics[0].action, "ask-user");
  assert.equal(result.diagnostics[0].infer, false);
});

test("reports the next missing level", () => {
  const graph = buildKnowledgeGraph(canonicalNodes().slice(0, 3).map(source)).graph;
  const result = detectFrontier(config, graph, snapshot([]));
  assert.ok(result.diagnostics.some((item) => item.code === "PL0201 MISSING_BEHAVIOR"));
});

test("the behavior question asks for the occasion, not for a capability", () => {
  // "What should someone be able to observe or do" is answerable by restating the
  // Product rule with a modal in front of it. That fills the level without adding
  // a claim, and the level below it then has nothing to constrain. The occasion is
  // the thing a Product rule cannot have and a Behavior must.
  const graph = buildKnowledgeGraph(canonicalNodes().slice(0, 3).map(source)).graph;
  const result = detectFrontier(config, graph, snapshot([]));
  const missing = result.diagnostics.find((item) => item.code === "PL0201 MISSING_BEHAVIOR");
  assert.match(missing.question, /on what occasion/);
  assert.doesNotMatch(missing.question, /be able to/);
});

test("a complete chain with mapped files has no frontier", () => {
  const graph = buildKnowledgeGraph(canonicalNodes().map(source)).graph;
  const result = detectFrontier(config, graph, snapshot(["src/approve.ts", "test/approve.test.ts"]));
  assert.equal(result.complete, true);
});
