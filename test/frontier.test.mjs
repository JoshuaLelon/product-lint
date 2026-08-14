import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKnowledgeGraph,
  detectFrontier,
  obligationsFor,
  orderedObligations,
} from "../dist/index.js";
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

// --- Which obligation is next ---
//
// `frontier` is not a report, it is a work order: the template, the level's
// question, the siblings to read before writing a duplicate, and the terms in
// scope. That is forty lines per node, so handing over seven at once is the same
// wall the summary exists to prevent, one level down.

test("obligations order by leverage, and ties break so two runs agree", () => {
  const obligations = [
    { code: "PL0401 MISSING_MECHANISM", severity: "info", message: "x", requiredLevel: "mechanism", frontier: "architecture.b" },
    { code: "PL0101 MISSING_PRODUCT", severity: "info", message: "x", requiredLevel: "product", frontier: "context.z" },
    { code: "PL0501 MISSING_IMPLEMENTATION", severity: "info", message: "x", requiredLevel: "implementation", nodeId: "mechanism.a" },
    { code: "PL0101 MISSING_PRODUCT", severity: "info", message: "x", requiredLevel: "product", frontier: "context.a" },
  ];
  assert.deepEqual(
    orderedObligations(obligations).map((item) => item.frontier ?? item.nodeId),
    // A Context answer decides what every node beneath it is even for, so
    // writing a Mechanism before it is work that may not survive.
    ["context.a", "context.z", "architecture.b", "mechanism.a"],
  );
  // A work order that moves between runs cannot be handed to anyone.
  assert.deepEqual(orderedObligations(obligations), orderedObligations([...obligations].reverse()));
});

test("a node id selects its own work order, and selects nothing when it has none", () => {
  const obligations = [
    { code: "PL0101 MISSING_PRODUCT", severity: "info", message: "x", requiredLevel: "product", frontier: "context.a" },
    { code: "PL0501 MISSING_IMPLEMENTATION", severity: "info", message: "x", requiredLevel: "implementation", nodeId: "mechanism.a" },
  ];
  assert.equal(obligationsFor(obligations, "context.a").length, 1);
  assert.equal(obligationsFor(obligations, "mechanism.a").length, 1, "matched by nodeId too");
  assert.deepEqual(obligationsFor(obligations, "context.missing"), []);
});
