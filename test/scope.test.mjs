// Scope: which problems are being built right now, and what the report does
// about the rest. Scope silences obligations and never invariants — a deferred
// problem stops demanding the levels below it and does not stop being valid.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildKnowledgeGraph,
  formatDiagnostic,
  hasErrors,
  inspectWorkingTree,
  loadConfig,
  resolveScope,
  scopeDiagnostics,
  synchronizeStaged,
} from "../dist/index.js";
import { createRepository, git, writeNode } from "./_helpers.mjs";

function sourced(nodes) {
  return nodes.map((node) => ({ ...node, sourcePath: `docs/${node.level}/${node.id}.json` }));
}

/** A forest where one product law serves two problems, which is the whole test. */
function sharedGraph() {
  return buildKnowledgeGraph(
    sourced([
      { id: "audience.role.member", level: "audience", statement: "People who keep lists.", constrainedBy: [] },
      { id: "context.kept", level: "context", statement: "A problem being built.", constrainedBy: ["audience.role.member"] },
      { id: "context.deferred", level: "context", statement: "A problem recorded, not built.", constrainedBy: ["audience.role.member"] },
      { id: "product.shared", level: "product", statement: "A law both problems need.", constrainedBy: ["context.kept", "context.deferred"] },
      { id: "product.only-deferred", level: "product", statement: "A law only the deferred problem needs.", constrainedBy: ["context.deferred"] },
    ]),
  ).graph;
}

async function setScope(root, scope) {
  const file = path.join(root, "product-lint.config.json");
  const config = JSON.parse(await readFile(file, "utf8"));
  if (scope) config.scope = scope;
  else delete config.scope;
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

test("a node serving a kept problem AND a deferred one stays in scope", () => {
  const graph = sharedGraph();
  const scope = resolveScope(
    { scope: { roots: ["context.kept"], because: "x" }, configPath: "c" },
    graph,
  );
  // The trap sliceForAudience already documents: the deferred set is the
  // COMPLEMENT of the kept closure, never the closure of the other roots.
  // Growing it downward from context.deferred would defer product.shared, which
  // the kept problem needs, and the report would then demand nothing for it.
  assert.equal(scope.inScope.has("product.shared"), true);
  assert.equal(scope.inScope.has("product.only-deferred"), false);
  // Ancestors are in scope: the audience decides who the kept problem is for.
  assert.equal(scope.inScope.has("audience.role.member"), true);
  assert.deepEqual(scope.deferredRoots, ["context.deferred"]);
  // And the news that the deferred problem is already partly built.
  assert.deepEqual(scope.contested, ["product.shared"]);
});

test("a root naming nothing is an error, not a silence", () => {
  const graph = sharedGraph();
  const diagnostics = scopeDiagnostics(
    { scope: { roots: ["context.typo", "context.kept"], because: "x" }, configPath: "c" },
    graph,
  );
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "PL1401 UNKNOWN_SCOPE_ROOT");
  assert.equal(diagnostics[0].severity, "error");
  // A typo would otherwise scope the graph to nothing reachable and quiet the
  // whole report, which reads exactly like a clean repository.
  assert.match(formatDiagnostic(diagnostics[0]).toLowerCase(), /quiets the whole report/);
});

test("scope defers obligations and keeps invariants", async () => {
  const { root } = await createRepository();
  await writeNode(root, {
    id: "context.deferred-problem",
    level: "context",
    statement: "A second problem nobody is building yet.",
    constrainedBy: ["audience.role.reviewer"],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", ".");
  await synchronizeStaged(await loadConfig(root));
  await git(root, "add", ".");

  const unscoped = await inspectWorkingTree(await loadConfig(root));
  const deferredObligation = (status) =>
    status.frontier.diagnostics.some(
      (item) => item.frontier === "context.deferred-problem",
    );
  assert.equal(deferredObligation(unscoped), true, "unscoped, the new problem owes a product law");

  await setScope(root, {
    roots: ["context.review-problem"],
    because: "Shipping the review problem first.",
  });
  const scoped = await inspectWorkingTree(await loadConfig(root));
  assert.equal(deferredObligation(scoped), false, "scoped, the demand is held back");
  assert.equal(scoped.frontier.scope.deferredRoots.length, 1);
  assert.ok(scoped.frontier.scope.deferred > 0, "held back, and counted");

  // Invariants do not move: the deferred node is still synchronized, still
  // parsed, still parented. Only what it OWES went quiet.
  assert.equal(hasErrors(scoped.validation.diagnostics), false);
  assert.equal(scoped.synchronization.length, 0);

  // --all widens for one run, and needs no recorded reason to do it.
  const widened = await inspectWorkingTree(await loadConfig(root), true);
  assert.equal(deferredObligation(widened), true);
  assert.equal(widened.frontier.scope, undefined);
});

test("scope.roots without a reason is refused at load", async () => {
  const { root } = await createRepository();
  await setScope(root, { roots: ["context.review-problem"] });
  await assert.rejects(() => loadConfig(root), /carries its reason/);
  // And an empty scope is simply the whole forest, which is the default.
  await setScope(root, { roots: [], because: "" });
  const config = await loadConfig(root);
  assert.equal(config.scope, undefined);
});
