// The summary: one screen that says what to do next.
//
// The full blocks are right and they are the wrong thing to open with. A single
// PL0201 prints its question, its fix, the asking formats, the statement style,
// the shape rule, the vocabulary rule, and twenty sibling nodes — so the first
// fifteen lines of `check` used to be one finding's remediation prose.

import test from "node:test";
import assert from "node:assert/strict";
import { buildKnowledgeGraph, labelFor, renderSummary, summaryRows } from "../dist/index.js";

function sourced(nodes) {
  return nodes.map((node) => ({ ...node, sourcePath: `docs/${node.level}/${node.id}.json` }));
}

const graph = buildKnowledgeGraph(
  sourced([
    { id: "audience.role.member", level: "audience", statement: "People.", constrainedBy: [] },
    { id: "context.core", level: "context", statement: "A problem.", constrainedBy: ["audience.role.member"] },
    { id: "product.one", level: "product", statement: "A law.", constrainedBy: ["context.core"] },
  ]),
).graph;

test("a code becomes its own short label, so a new code needs no table entry", () => {
  assert.equal(labelFor("PL0901 DRAFT_NODE"), "draft-node");
  assert.equal(labelFor("PL0201 MISSING_BEHAVIOR"), "missing-behavior");
  assert.equal(labelFor("PL0910 IMBALANCE"), "imbalance");
});

test("errors sort above everything, then shallowest level, then no level at all", () => {
  const rows = summaryRows(
    [
      { code: "PL0910 IMBALANCE", severity: "info", message: "x", nodeId: "context.core" },
      { code: "PL0602 UNGOVERNED_TREE", severity: "info", message: "x" },
      { code: "PL0101 MISSING_PRODUCT", severity: "info", message: "x", requiredLevel: "product" },
      { code: "PL1104 MISSING_CONSTRAINT_NODE", severity: "error", message: "x", nodeId: "product.one" },
    ],
    graph,
  );
  assert.deepEqual(
    rows.map((row) => row.label),
    [
      // An invalid graph is not an incomplete one, so the error outranks the
      // shallower finding — the same rank applyStatusExitCode already uses.
      "missing-constraint-node",
      "imbalance",
      "missing-product",
      // About the repository rather than a layer, so it sorts after the layers
      // rather than pretending to be the shallowest.
      "ungoverned-tree",
    ],
  );
  assert.equal(rows[1].level, "context");
  assert.equal(rows[3].level, undefined);
});

test("findings of one code at one level fold into a row that keeps the count", () => {
  const rows = summaryRows(
    [
      { code: "PL0601 UNMAPPED_FILE", severity: "info", message: "x", requiredLevel: "mechanism", path: "src/a.ts" },
      { code: "PL0601 UNMAPPED_FILE", severity: "info", message: "x", requiredLevel: "mechanism", path: "src/b.ts" },
    ],
    graph,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].count, 2);
  assert.equal(rows[0].exemplar, "src/a.ts", "a row is actionable without expanding it");
});

test("drafts expand per level, because sixteen of them are not one job", () => {
  const rows = summaryRows(
    [
      {
        code: "PL0901 DRAFT_NODE",
        severity: "info",
        message: "x",
        details: {
          drafts: [
            { level: "context", ids: ["context.draft-a", "context.draft-b"] },
            { level: "product", ids: ["product.draft-a"] },
          ],
        },
      },
    ],
    graph,
  );
  // Folding them into one row would hide the only ordering that matters for
  // them: a context job first, and then a product job.
  assert.deepEqual(
    rows.map((row) => [row.level, row.count]),
    [
      ["context", 2],
      ["product", 1],
    ],
  );
});

test("the summary fits a screen, and says what it did not show", () => {
  const many = Array.from({ length: 14 }, (_, index) => ({
    code: `PL09${String(index).padStart(2, "0")} SMELL_${index}`,
    severity: "info",
    message: "x",
    nodeId: "context.core",
  }));
  const text = renderSummary({ diagnostics: many, graph, limit: 4 });
  assert.ok(text.split("\n").length <= 12, "a reader heads the output, so it has to fit");
  // Stated, never silent: a list that stops without saying so reads as whole.
  assert.match(text, /\.\.\. and more\s+10/);
});

test("what scope deferred and what config ignored are named, never merely absent", () => {
  const text = renderSummary({
    diagnostics: [{ code: "PL0910 IMBALANCE", severity: "info", message: "x", nodeId: "context.core" }],
    graph,
    scope: {
      roots: ["context.core"],
      because: "Shipping the core problem first.",
      deferredRoots: ["context.edge-a", "context.edge-b"],
      deferred: 4,
      contested: 1,
    },
    ignored: [{ smell: "thin", nodeId: "context.edge-a", because: "One law is genuinely enough." }],
  });
  assert.match(text, /scope: 1 of 3 problems — 4 finding\(s\) deferred, 1 shared with them/);
  assert.match(text, /because: Shipping the core problem first\./);
  assert.match(text, /ignored: thin on context\.edge-a — One law is genuinely enough\./);
  assert.match(text, /check --all/);
});

test("a clean repository says so in one line", () => {
  assert.equal(renderSummary({ diagnostics: [], graph }), "no findings.\n");
});
