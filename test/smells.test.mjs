// Shape findings. Every check before these is local — does this node have a
// child, does this node's parent exist — and none of them look at the
// distribution. A graph can pass `ship` and still be a mess.
//
// Most of what is tested here belongs to the HARNESS rather than to any smell,
// because getting it wrong once would poison every smell that ever lands.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SMELLS,
  buildKnowledgeGraph,
  detectSmells,
  formatDiagnostic,
  loadConfig,
  resolveScope,
  smellConfigDiagnostics,
} from "../dist/index.js";
import { createRepository } from "./_helpers.mjs";

function sourced(nodes) {
  return nodes.map((node) => ({ ...node, sourcePath: `docs/${node.level}/${node.id}.json` }));
}

/** Three problems, one holding six of seven laws. */
function lopsided(overrides = {}) {
  const nodes = [
    { id: "audience.role.member", level: "audience", statement: "People who keep lists.", constrainedBy: [] },
    ...["core", "edge-a", "edge-b"].map((name) => ({
      id: `context.${name}`,
      level: "context",
      statement: `Problem ${name}.`,
      constrainedBy: ["audience.role.member"],
      ...(overrides[`context.${name}`] ?? {}),
    })),
    ...Array.from({ length: 6 }, (_, index) => ({
      id: `product.core-${index}`,
      level: "product",
      statement: `Core promise ${index}.`,
      constrainedBy: ["context.core"],
    })),
    { id: "product.edge", level: "product", statement: "One edge promise.", constrainedBy: ["context.edge-a"] },
  ];
  return buildKnowledgeGraph(sourced(nodes)).graph;
}

const bareConfig = { configPath: "product-lint.config.json" };

test("imbalance names the dominant node, its share, and its thin siblings", () => {
  const report = detectSmells(bareConfig, lopsided());
  assert.equal(report.diagnostics.length, 1);
  const [finding] = report.diagnostics;
  assert.equal(finding.code, "PL0910 IMBALANCE");
  assert.equal(finding.nodeId, "context.core");
  assert.equal(finding.severity, "info", "a shape is a review, never a gate");
  assert.equal(finding.details.held, 6);
  assert.equal(finding.details.total, 7);
  assert.deepEqual(
    finding.details.siblings.map((item) => item.held).sort(),
    [0, 1],
    "the thin siblings are the other half of the finding",
  );
});

test("every finding says what would make the shape correct", () => {
  const report = detectSmells(bareConfig, lopsided());
  // These are all "usually fine, sometimes a tell" — a product may genuinely
  // have one core problem. A finding that only accuses teaches the reader to
  // skip the report, so whenFine is a required field rather than a convention.
  for (const finding of report.diagnostics) {
    assert.equal(typeof finding.details.whenFine, "string");
    assert.ok(finding.details.whenFine.length > 0);
  }
  assert.match(formatDiagnostic(report.diagnostics[0]), /when fine: /);
});

test("draft nodes are invisible to every smell", () => {
  // A freshly adopted repository is N identical chains, which is a degenerate
  // forest — every distribution metric would fire on scaffolding, and the
  // report would be useless at exactly the moment someone first reads it.
  const drafted = lopsided({
    "context.core": { draft: true },
    "context.edge-a": { draft: true },
    "context.edge-b": { draft: true },
  });
  assert.deepEqual(detectSmells(bareConfig, drafted).diagnostics, []);
});

test("out-of-scope findings are held back and counted, never dropped", () => {
  const graph = lopsided();
  const scope = resolveScope(
    { ...bareConfig, scope: { roots: ["context.edge-a"], because: "x" } },
    graph,
  );
  const report = detectSmells(bareConfig, graph, scope);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(report.deferred, 1, "the quiet is stated, never assumed");
});

test("an ignore silences one smell and carries the reason it was silenced", () => {
  const config = {
    ...bareConfig,
    smells: {
      ignore: [
        {
          smell: "imbalance",
          node: "context.core",
          because: "One problem IS the product; the others are adjacent surfaces.",
        },
      ],
    },
  };
  const report = detectSmells(config, lopsided());
  assert.deepEqual(report.diagnostics, []);
  assert.deepEqual(report.ignored, [
    {
      smell: "imbalance",
      nodeId: "context.core",
      because: "One problem IS the product; the others are adjacent surfaces.",
    },
  ]);

  // A node-scoped ignore does not silence the smell everywhere.
  const elsewhere = detectSmells(
    { ...config, smells: { ignore: [{ ...config.smells.ignore[0], node: "context.edge-a" }] } },
    lopsided(),
  );
  assert.equal(elsewhere.diagnostics.length, 1);
});

test("an ignore naming no known smell is an error, because it silences nothing", () => {
  const diagnostics = smellConfigDiagnostics({
    ...bareConfig,
    smells: { ignore: [{ smell: "imbalanc", because: "typo" }] },
  });
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "PL1402 UNKNOWN_SMELL");
  assert.equal(diagnostics[0].severity, "error");
  assert.match(diagnostics[0].message, /Known: imbalance/);
});

test("an ignore without a reason is refused at load", async () => {
  const { root } = await createRepository();
  const file = path.join(root, "product-lint.config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  config.smells = { ignore: [{ smell: "imbalance" }] };
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  // Same standard as scope: silencing a finding is a decision, and a decision
  // without its reason is a suppression list.
  await assert.rejects(() => loadConfig(root), /says why it is ignored/);
});

test("thresholds are fixed, and small graphs stay quiet", () => {
  // Two parents split 60/40 by arithmetic, so a share below three parents means
  // nothing; four children is a handful, not a distribution. Both guards exist
  // so the first repository to adopt this does not open on a false finding.
  const twoParents = buildKnowledgeGraph(
    sourced([
      { id: "audience.role.member", level: "audience", statement: "People.", constrainedBy: [] },
      { id: "context.a", level: "context", statement: "A.", constrainedBy: ["audience.role.member"] },
      { id: "context.b", level: "context", statement: "B.", constrainedBy: ["audience.role.member"] },
      ...Array.from({ length: 6 }, (_, index) => ({
        id: `product.a-${index}`,
        level: "product",
        statement: `Promise ${index}.`,
        constrainedBy: ["context.a"],
      })),
    ]),
  ).graph;
  assert.deepEqual(detectSmells(bareConfig, twoParents).diagnostics, []);
});

test("the registry is the extension point: a smell is an entry and a detect", () => {
  // The whole reason this landed before the smells themselves. Adding one must
  // not mean rediscovering how findings reach the report.
  for (const smell of SMELLS) {
    assert.match(smell.code, /^PL09\d\d [A-Z_]+$/);
    assert.equal(typeof smell.name, "string");
    assert.equal(typeof smell.detect, "function");
  }
  assert.deepEqual(
    SMELLS.map((smell) => smell.name),
    [...new Set(SMELLS.map((smell) => smell.name))],
    "one name, one smell — the ignore key has to be unambiguous",
  );
});
