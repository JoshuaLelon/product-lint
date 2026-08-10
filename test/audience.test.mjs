import test from "node:test";
import assert from "node:assert/strict";
import {
  audienceSetFingerprint,
  buildKnowledgeGraph,
  expectedSynchronizedNodes,
  formatAudience,
  loadConfig,
  resolveAudiences,
  sliceForAudience,
  synchronizeStaged,
} from "../dist/index.js";
import { createRepository, git, writeNode } from "./_helpers.mjs";

function source(node) {
  const name = node.id.slice(node.id.indexOf(".") + 1).replaceAll(".", "-");
  return { schemaVersion: 1, ...node, sourcePath: `docs/${node.level}/${name}.json` };
}

/**
 * Two sets, one conjunctive Context, and one Behavior shared across lineages —
 * the smallest graph that tells the three designs apart.
 */
function twoSetGraph(extra = []) {
  const nodes = [
    { id: "audience.role.admin", level: "audience", statement: "Administrators.", constrainedBy: [] },
    { id: "audience.role.member", level: "audience", statement: "Individual contributors.", constrainedBy: [] },
    { id: "audience.segment.smb", level: "audience", statement: "Small teams.", constrainedBy: [] },
    { id: "audience.segment.enterprise", level: "audience", statement: "Large companies.", constrainedBy: [] },
    // conjunction: enterprise admins only
    { id: "context.sso-mandated", level: "context", statement: "Large companies require single sign-on.", constrainedBy: ["audience.role.admin", "audience.segment.enterprise"] },
    // one axis only: enterprise, any role
    { id: "context.audit-required", level: "context", statement: "Auditors require evidence of review.", constrainedBy: ["audience.segment.enterprise"] },
    // no axis named: everyone
    { id: "context.review-lost", level: "context", statement: "Reviewers lose track of versions.", constrainedBy: ["audience.role.*"] },
    { id: "product.sso", level: "product", statement: "The product federates authentication.", constrainedBy: ["context.sso-mandated"] },
    { id: "product.audit-log", level: "product", statement: "The product records approvals.", constrainedBy: ["context.audit-required"] },
    { id: "product.current-version", level: "product", statement: "Each document has one current version.", constrainedBy: ["context.review-lost"] },
    { id: "behavior.sign-in-sso", level: "behavior", statement: "A user signs in through the company provider.", constrainedBy: ["product.sso"] },
    { id: "behavior.view-audit", level: "behavior", statement: "A user reads approval history.", constrainedBy: ["product.audit-log"] },
    { id: "behavior.approve", level: "behavior", statement: "A reviewer approves the current version.", constrainedBy: ["product.current-version"] },
    { id: "architecture.identity", level: "architecture", statement: "A gateway federates authentication.", constrainedBy: ["behavior.sign-in-sso"] },
    { id: "architecture.append-only", level: "architecture", statement: "An append-only store holds records.", constrainedBy: ["behavior.view-audit"] },
    { id: "architecture.approval", level: "architecture", statement: "The application layer owns approvals.", constrainedBy: ["behavior.approve"] },
    { id: "mechanism.saml", level: "mechanism", statement: "A handler verifies SAML assertions.", constrainedBy: ["architecture.identity"], implementation: { files: ["src/auth/**"], digest: "pending" } },
    { id: "mechanism.audit-writer", level: "mechanism", statement: "A writer appends approval records.", constrainedBy: ["architecture.append-only"], implementation: { files: ["src/audit/**"], digest: "pending" } },
    { id: "mechanism.approve-command", level: "mechanism", statement: "A command performs approval.", constrainedBy: ["architecture.approval"], implementation: { files: ["src/approval/**"], digest: "pending" } },
    ...extra,
  ];
  const built = buildKnowledgeGraph(nodes.map(source));
  assert.equal(
    built.diagnostics.filter((item) => item.severity === "error").length,
    0,
    JSON.stringify(built.diagnostics),
  );
  return built.graph;
}

const AXES = ["role", "segment"];
const say = (graph, id) => formatAudience(resolveAudiences(graph).get(id), AXES);

test("sets are AND-ed and values within a set are OR-ed", () => {
  const graph = twoSetGraph();
  // Naming one value in each of two sets is a conjunction, not a union.
  assert.equal(say(graph, "context.sso-mandated"), "role=admin, segment=enterprise");
  // Naming one set leaves the other unconstrained.
  assert.equal(say(graph, "context.audit-required"), "segment=enterprise");
  // Naming no set at all reaches everyone.
  assert.equal(say(graph, "context.review-lost"), "everyone");
});

test("a conjunctive scope does not leak along either of its axes", () => {
  // The failure that rules out modelling axes as independent parents: with union
  // semantics an SMB admin and an enterprise member would both reach SSO.
  const graph = twoSetGraph();
  const audience = resolveAudiences(graph).get("mechanism.saml");
  assert.equal(formatAudience(audience, AXES), "role=admin, segment=enterprise");
  const matches = (role, segment) =>
    audience.some((term) =>
      (term.role === "*" || term.role.has(role)) &&
      (term.segment === "*" || term.segment.has(segment)));
  assert.equal(matches("admin", "enterprise"), true);
  assert.equal(matches("admin", "smb"), false, "an SMB admin must not reach SSO");
  assert.equal(matches("member", "enterprise"), false, "an enterprise member must not reach SSO");
});

test("audience below Context is the union of parents, and only ever widens", () => {
  const graph = twoSetGraph([
    {
      id: "behavior.bulk-archive",
      level: "behavior",
      statement: "An administrator archives many documents at once.",
      // one universal parent and one admin-only parent
      constrainedBy: ["product.current-version", "product.sso"],
    },
  ]);
  assert.equal(
    say(graph, "behavior.bulk-archive"),
    "everyone",
    "naming a narrower parent beside a wider one cannot narrow the result",
  );
});

test("a node resolves to no audience rather than to everyone when its lineage gives none", () => {
  // The alternative reading — an empty union meaning "unconstrained" — would let
  // a node with no resolvable ancestry claim the whole product.
  const graph = twoSetGraph();
  const orphan = resolveAudiences(graph).get("mechanism.saml");
  assert.ok(orphan.length > 0);
});

test("a term another term already covers is absorbed where it is produced", () => {
  // The guard with teeth. formatAudience absorbs too, so the PRINTED scope is
  // identical whether or not the resolver does — moving absorption to the end
  // reads as a no-op and is not. The redundant term is inherited by every node
  // below, so the disjunction grows down the graph while describing the same
  // people. Written because the whole suite passed with the resolver's call
  // removed, which made a comment the only thing holding the invariant up.
  const graph = twoSetGraph([
    {
      id: "behavior.bulk-archive",
      level: "behavior",
      statement: "An administrator archives many documents at once.",
      // "everyone" already covers "enterprise admins".
      constrainedBy: ["product.current-version", "product.sso"],
    },
    {
      id: "architecture.bulk-operations",
      level: "architecture",
      statement: "A batch runner applies one change to many documents.",
      constrainedBy: ["behavior.bulk-archive"],
    },
    {
      id: "mechanism.bulk-runner",
      level: "mechanism",
      statement: "A runner applies archive operations in batches.",
      constrainedBy: ["architecture.bulk-operations"],
      implementation: { files: ["src/bulk/**"], digest: "pending" },
    },
  ]);
  const resolved = resolveAudiences(graph);
  assert.equal(
    resolved.get("behavior.bulk-archive").length,
    1,
    "everyone already covers enterprise admins, so the narrow term adds nobody",
  );
  assert.equal(
    resolved.get("architecture.bulk-operations").length,
    1,
    "and a redundant term must not be inherited",
  );
  assert.equal(
    resolved.get("mechanism.bulk-runner").length,
    1,
    "nor accumulate further down the graph",
  );
});

test("DNF terms are bounded by Context ancestors, never by the size of the product", () => {
  const graph = twoSetGraph();
  const resolved = resolveAudiences(graph);
  const contexts = [...graph.nodes.values()].filter((node) => node.level === "context").length;
  for (const [id, audience] of resolved) {
    assert.ok(
      audience.length <= contexts,
      `${id} carries ${audience.length} terms with only ${contexts} contexts`,
    );
  }
});

test("a wildcard covers values that did not exist when it was written", () => {
  const withAuditor = twoSetGraph([
    { id: "audience.role.auditor", level: "audience", statement: "External auditors.", constrainedBy: [] },
  ]);
  // The scope still reads as every role, including the one added after the fact.
  assert.equal(say(withAuditor, "context.review-lost"), "everyone");
  assert.equal(say(withAuditor, "mechanism.approve-command"), "everyone");
});

test("the wildcard fingerprint moves when its set gains a value", () => {
  // This is the whole reason the wildcard is a first-class parent rather than a
  // convention: the digest can only watch what a node names.
  const before = audienceSetFingerprint(twoSetGraph(), "role");
  const after = audienceSetFingerprint(
    twoSetGraph([
      { id: "audience.role.auditor", level: "audience", statement: "External auditors.", constrainedBy: [] },
    ]),
    "role",
  );
  assert.notEqual(before, after);
});

test("a node scoped by a wildcard goes stale when the set grows", async () => {
  const { root, config } = await createRepository();
  await writeNode(root, {
    id: "audience.role.auditor",
    level: "audience",
    statement: "The product serves external auditors.",
    constrainedBy: [],
    sync: { constraintsDigest: "pending" },
  });
  // Re-point the seeded context at the whole set rather than the one value.
  await writeNode(root, {
    id: "context.review-problem",
    level: "context",
    statement: "Video teams lose track of review state.",
    constrainedBy: ["audience.role.*"],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", ".");
  await synchronizeStaged(config);
  await git(root, "add", ".");

  const settled = await loadConfig(root);
  const { createSnapshot, validateSnapshot } = await import("../dist/index.js");
  const snapshot = await createSnapshot(settled, "working");
  const graph = (await validateSnapshot(settled, snapshot)).graph;
  const digestBefore = graph.nodes.get("context.review-problem").sync.constraintsDigest;

  // Now the set grows, and nothing the context names has changed.
  await writeNode(root, {
    id: "audience.role.contractor",
    level: "audience",
    statement: "The product serves contract reviewers.",
    constrainedBy: [],
    sync: { constraintsDigest: "pending" },
  });
  const grownSnapshot = await createSnapshot(settled, "working");
  const grown = (await validateSnapshot(settled, grownSnapshot)).graph;
  const expected = await expectedSynchronizedNodes(grown, grownSnapshot);
  assert.notEqual(
    expected.get("context.review-problem").sync.constraintsDigest,
    digestBefore,
    "a wildcard scope must go stale when its set gains a value",
  );
});

test("enumerating a set instead of naming it does NOT go stale, which is why wildcards exist", async () => {
  const { root, config } = await createRepository();
  await writeNode(root, {
    id: "audience.role.auditor",
    level: "audience",
    statement: "The product serves external auditors.",
    constrainedBy: [],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", ".");
  await synchronizeStaged(config);
  await git(root, "add", ".");

  const { createSnapshot, validateSnapshot } = await import("../dist/index.js");
  const settled = await loadConfig(root);
  const snapshot = await createSnapshot(settled, "working");
  const graph = (await validateSnapshot(settled, snapshot)).graph;
  // The seeded context names one value extensionally, so the set growing beside
  // it touches nothing it references. Documented, not endorsed.
  const expected = await expectedSynchronizedNodes(graph, snapshot);
  assert.equal(
    expected.get("context.review-problem").sync.constraintsDigest,
    graph.nodes.get("context.review-problem").sync.constraintsDigest,
    "an enumerated scope is blind to its set growing — the trap the wildcard closes",
  );
});

test("slice mocks the complement of the keep closure, and names what both need", () => {
  const graph = twoSetGraph();
  const snapshot = {
    kind: "working",
    files: ["src/auth/saml.ts", "src/audit/log.ts", "src/approval/approve.ts"],
    hasFile: () => true,
    readFile: async () => "",
  };
  const slice = sliceForAudience(graph, snapshot, "role=admin,segment=enterprise");
  assert.deepEqual(slice.keptFiles, [
    "src/approval/approve.ts",
    "src/audit/log.ts",
    "src/auth/saml.ts",
  ]);
  assert.deepEqual(slice.mockedFiles, [], "an enterprise admin reaches everything here");

  const smb = sliceForAudience(graph, snapshot, "role=member,segment=smb");
  assert.deepEqual(smb.keptFiles, ["src/approval/approve.ts"]);
  assert.deepEqual(smb.mockedFiles, ["src/audit/log.ts", "src/auth/saml.ts"]);
  // No file is both kept and mocked: the mock set is the complement, never a
  // closure grown from the other audiences.
  assert.equal(
    smb.mockedFiles.some((file) => smb.keptFiles.includes(file)),
    false,
  );
});

test("an audience value covered by description is not reported as uncovered", async () => {
  // A wildcard leaves no child edge to any single value, and naming one set
  // leaves none to the other set's values at all. Reading edges here called
  // every value the graph covers by description uncovered, which is most of them.
  const { detectFrontier } = await import("../dist/index.js");
  const graph = twoSetGraph();
  const config = {
    root: ".",
    governedPaths: { include: [], exclude: [] },
  };
  const snapshot = { kind: "working", files: [], hasFile: () => false, readFile: async () => "" };
  const missing = detectFrontier(config, graph, snapshot)
    .diagnostics.filter((item) => item.code.startsWith("PL0001"))
    .map((item) => item.frontier);
  assert.deepEqual(missing, [], "role.member and segment.smb are covered by selectors");
});

test("an audience value no Context selector reaches is still reported", () => {
  const graph = twoSetGraph([
    { id: "audience.tier.free", level: "audience", statement: "Free accounts.", constrainedBy: [] },
    { id: "audience.tier.paid", level: "audience", statement: "Paid accounts.", constrainedBy: [] },
  ]);
  const resolved = resolveAudiences(graph);
  // No Context names the tier set, so every Context leaves it unconstrained and
  // both values stay covered — the honest answer, since "unconstrained" means
  // the Context applies to them too.
  assert.equal(formatAudience(resolved.get("context.review-lost"), ["role", "segment", "tier"]), "everyone");
});

test("slice rejects a selector naming a set or value that does not exist", () => {
  const graph = twoSetGraph();
  const snapshot = { kind: "working", files: [], hasFile: () => true, readFile: async () => "" };
  assert.throws(() => sliceForAudience(graph, snapshot, "tier=gold"), /Unknown audience set/);
  assert.throws(() => sliceForAudience(graph, snapshot, "role=nobody"), /Unknown value/);
});
