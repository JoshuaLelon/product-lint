// The summary: one screen that says what to do next.
//
// The full blocks are right and they are the wrong thing to open with. A single
// PL0201 prints its question, its fix, the asking formats, the statement style,
// the shape rule, the vocabulary rule, and twenty sibling nodes — so the first
// fifteen lines of `check` used to be one finding's remediation prose.

import test from "node:test";
import assert from "node:assert/strict";
import {
  buildKnowledgeGraph,
  labelFor,
  renderBrief,
  renderRefusal,
  renderSummary,
  summaryRows,
} from "../dist/index.js";

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

test("drafts group per level without a special case, because each is its own obligation", () => {
  const rows = summaryRows(
    [
      { code: "PL0901 DRAFT_NODE", severity: "info", message: "x", requiredLevel: "context", frontier: "context.draft-a" },
      { code: "PL0901 DRAFT_NODE", severity: "info", message: "x", requiredLevel: "context", frontier: "context.draft-b" },
      { code: "PL0901 DRAFT_NODE", severity: "info", message: "x", requiredLevel: "product", frontier: "product.draft-a" },
    ],
    graph,
  );
  // Sixteen drafts are not one job: a context job first, then a product job.
  // This used to need an expansion special case, because PL0901 was one
  // diagnostic carrying a per-level split. One diagnostic per node gets the
  // same rows out of the ordinary (severity, level, code) grouping.
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

// --- The commit seam ---
//
// Two messages that must not blend. A refusal carries nothing but the refusal;
// a pass carries what to do next, because the commit is the one moment the tool
// is certain to be read and spending it on silence is how a repository drifts.

test("a refusal carries the errors and the commands that give context for them", () => {
  const text = renderRefusal([
    {
      code: "PL2102 STALE_STAGED_MECHANISM",
      severity: "error",
      message: "src/approve.ts changed, but governing node mechanism.owner is not staged.",
      nodeId: "mechanism.owner",
      command: "product-lint knowledge sync --staged",
    },
    {
      code: "PL0602 UNGOVERNED_TREE",
      severity: "error",
      message: "3 files have no owner.",
      requiredLevel: "architecture",
      details: { files: ["src/a.ts", "src/b.ts"] },
    },
    { code: "PL0801 UNMARKED_TERM_USE", severity: "info", message: "noise that must not appear" },
  ]);
  assert.match(text, /commit blocked — 2 errors in 2 groups, first cause first/);
  // Derived from the subjects rather than guessed at: the difference between
  // "a node is stale" and knowing which file to open.
  assert.match(text, /product-lint llms affected-by mechanism\.owner/);
  assert.match(text, /product-lint llms for-file src\/a\.ts/);
  // A refusal is not a place to list unrelated opportunities.
  assert.doesNotMatch(text, /noise that must not appear/);
  assert.doesNotMatch(text, /highest leverage/);
});

test("refusals rank by cause, because the lower groups may not survive the repair", () => {
  const text = renderRefusal([
    { code: "PL2001 STALE_CONSTRAINTS", severity: "error", message: "a", nodeId: "product.a", command: "sync" },
    { code: "PL1307 MISSING_TERM", severity: "error", message: "b", nodeId: "behavior.x" },
    { code: "PL1104 MISSING_CONSTRAINT_NODE", severity: "error", message: "c", nodeId: "product.one" },
    { code: "PL1009 MISSING_STATEMENT", severity: "error", message: "d", nodeId: "product.two" },
  ]);
  const order = text
    .split("\n")
    .filter((line) => /^ {2}\d\./.test(line))
    .map((line) => line.replace(/^ {2}\d\.\s+/, "").split("   ")[0]);
  // A file that does not parse contributes no node, so the graph built without
  // it is missing parents that exist on disk; a graph that does not build has
  // no lineage, so every digest over it is meaningless.
  assert.deepEqual(order, [
    "the files do not parse",
    "the graph does not build",
    "words do not resolve",
    "derived data is stale",
  ]);
  assert.match(text, /Fix group 1 first/);
});

test("one subject with several faults is one line; many subjects with one repair is one command", () => {
  const text = renderRefusal([
    // One file, three problems, fixed in one edit — splitting them across rows
    // makes one job look like three.
    { code: "PL1009 MISSING_STATEMENT", severity: "error", message: "a", nodeId: "product.one" },
    { code: "PL1002 UNKNOWN_NODE_FIELD", severity: "error", message: "b", nodeId: "product.one" },
    { code: "PL1007 ID_LEVEL_MISMATCH", severity: "error", message: "c", nodeId: "product.one" },
    // Twelve stale nodes and one command is a single instruction, not twelve.
    ...Array.from({ length: 12 }, (_, index) => ({
      code: "PL2001 STALE_CONSTRAINTS",
      severity: "error",
      message: `stale ${index}`,
      nodeId: `product.stale-${index}`,
      command: "product-lint knowledge sync --staged",
    })),
  ]);
  assert.match(text, /! product\.one {2}missing-statement, unknown-node-field, id-level-mismatch/);
  assert.match(text, /run: product-lint knowledge sync --staged {3}\(repairs all 12\)/);
  assert.doesNotMatch(text, /product\.stale-4/, "twelve subjects collapse into the one repair");
});

test("a tier with many broken subjects shows the worst and counts the rest", () => {
  const text = renderRefusal(
    ["a", "a", "b", "b", "c", "d", "e"].map((subject, index) => ({
      code: index % 2 === 0 ? "PL1009 MISSING_STATEMENT" : "PL1002 UNKNOWN_NODE_FIELD",
      severity: "error",
      message: `x${index}`,
      nodeId: `product.${subject}`,
    })),
  );
  // Sorted by how broken each subject is, so the file worth opening is first.
  assert.match(text, /! product\.a {2}/);
  assert.match(text, /\.\.\. and 2 more in 2 subject\(s\)/);
});

test("the brief is three rows, because it fires on every commit", () => {
  const many = Array.from({ length: 9 }, (_, index) => ({
    code: `PL01${String(index).padStart(2, "0")} THING_${index}`,
    severity: "info",
    message: "x",
    nodeId: "context.core",
  }));
  const text = renderBrief({ diagnostics: many, graph });
  // A fifteen-line wall of opportunities is read for a week and skipped forever
  // after. Three is a nudge; the whole picture is one command away.
  assert.equal(summaryRows(many, graph).length, 9, "nine findings exist");
  for (const named of ["thing-0", "thing-1", "thing-2"]) assert.match(text, new RegExp(named));
  assert.doesNotMatch(text, /thing-3/, "the fourth is counted, not named");
  assert.match(text, /6 more/);
  assert.match(text, /product-lint check/);
});

test("the brief names what is being ignored, collapsed", () => {
  const text = renderBrief({
    diagnostics: [{ code: "PL0910 IMBALANCE", severity: "info", message: "x", nodeId: "context.core" }],
    graph,
    scope: {
      roots: ["context.core"],
      because: "Shipping the core problem first.",
      deferredRoots: ["context.edge"],
      deferred: 4,
      contested: 0,
    },
    ignored: [
      { smell: "thin", nodeId: "context.a", because: "x" },
      { smell: "twin", because: "y" },
      { smell: "imbalance", nodeId: "context.b", because: "z" },
    ],
  });
  // A quiet report and a configured-quiet report look identical otherwise.
  assert.match(text, /4 deferred by scope \(Shipping the core problem first\.\)/);
  assert.match(text, /3 ignored \(thin on context\.a, twin, \+1\)/);
});

test("a clean repository with nothing to suggest says nothing at all", () => {
  assert.equal(renderBrief({ diagnostics: [], graph }), "");
});
