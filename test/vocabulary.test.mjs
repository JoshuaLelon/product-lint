// Vocabulary: terms declared where they are first needed, uses marked in
// prose, and the two failure modes the graph's own context node names —
// merging what differs, or keeping two records of the same thing. The
// decidable half is enforced; the judgement half is reported and a human
// decides, in the spirit of `contested`.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  affectedByTerm,
  annotateDiagnostic,
  buildKnowledgeGraph,
  capitalizedUndeclaredDiagnostics,
  buildVocabulary,
  checkCommitMessage,
  checkStagedCommit,
  formatDiagnostic,
  hasErrors,
  inspectWorkingTree,
  knowledgeForFile,
  loadConfig,
  NODE_SHAPE,
  parseMarks,
  renderFileKnowledgeForLlm,
  resolveMark,
  synchronizeStaged,
  synonymCandidateDiagnostics,
  unmarkedUseDiagnostics,
  unusedTermDiagnostics,
  VOCABULARY_RULE,
  vocabularyReport,
} from "../dist/index.js";
import {
  canonicalNodes,
  createRepository,
  git,
  readNode,
  readTerm,
  writeNode,
  writeTerm,
} from "./_helpers.mjs";

function sourced(nodes) {
  return nodes.map((node) => ({ ...node, sourcePath: `docs/${node.level}/${node.id}.json` }));
}

function term(overrides) {
  return {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
    sourcePath: "docs/product/terms/version.json",
    ...overrides,
  };
}

// --- The fourth rule ---

test("the vocabulary rule states both failure modes, and both directions", () => {
  assert.match(VOCABULARY_RULE, /One thing has one name/);
  assert.match(VOCABULARY_RULE, /One name has one thing/);
  assert.match(VOCABULARY_RULE, /coin a different name/, "homonymy's repair is a rename, not a merge");
  assert.match(VOCABULARY_RULE, /shallowest level whose statements need it/);
  assert.match(VOCABULARY_RULE, /never below/, "vocabulary flows the way knowledge does");
  assert.match(VOCABULARY_RULE, /Audience and context declare none/);
});

test("the vocabulary rule is not folded into the other three", () => {
  assert.doesNotMatch(NODE_SHAPE, /marked word/);
  assert.doesNotMatch(VOCABULARY_RULE, /ASD-STE100/);
  assert.doesNotMatch(VOCABULARY_RULE, /constrainedBy/);
});

test("diagnostics that add a node carry the vocabulary rule; unrelated ones do not", () => {
  const adds = annotateDiagnostic({ code: "PL0201 MISSING_BEHAVIOR", severity: "info", message: "x" });
  assert.equal(adds.vocabulary, VOCABULARY_RULE, "a new statement is where the next term gets used or coined");
  const missing = annotateDiagnostic({ code: "PL1307 MISSING_TERM", severity: "error", message: "x" });
  assert.equal(missing.vocabulary, VOCABULARY_RULE);
  const unrelated = annotateDiagnostic({ code: "PL2101 UNMAPPED_STAGED_FILE", severity: "error", message: "x" });
  assert.equal(unrelated.vocabulary, undefined);
});

test("the judgement codes carry their asks", () => {
  const unmarked = annotateDiagnostic({ code: "PL0801 UNMARKED_TERM_USE", severity: "info", message: "x" });
  assert.match(unmarked.ask, /that is the finding/);
  const synonym = annotateDiagnostic({ code: "PL0802 SYNONYM_CANDIDATE", severity: "info", message: "x" });
  assert.match(synonym.ask, /record only what they confirm/);
});

// --- Notation ---

test("marks parse, escapes hold, and malformed marks are named rather than guessed at", () => {
  assert.deepEqual(parseMarks("Only a *plan* the member approves.").marks, ["plan"]);
  assert.deepEqual(parseMarks("A *Won't Do* task stays.").marks, ["Won't Do"]);
  // \* is a literal asterisk, not a delimiter.
  assert.deepEqual(parseMarks("Multiply 2 \\* 3."), { marks: [], malformed: [] });
  assert.equal(parseMarks("An unbalanced *mark").malformed.length, 1);
  assert.equal(parseMarks("A padded * mark * here.").malformed.length, 1);
  assert.equal(parseMarks("An empty ** mark.").malformed.length, 1);
});

test("a mark resolves case-sensitively except its first character, with noun inflections", () => {
  const vocabulary = buildVocabulary([term()]);
  assert.equal(resolveMark("version", vocabulary).id, "term.version");
  assert.equal(resolveMark("Version", vocabulary).id, "term.version", "a term can open a sentence");
  assert.equal(resolveMark("versions", vocabulary).id, "term.version");
  assert.equal(resolveMark("version's", vocabulary).id, "term.version");
  assert.equal(resolveMark("VERSION", vocabulary), undefined, "only the first character folds");
});

// --- Enforcement: the decidable half rides validate/check ---

test("a marked word with no declaration is an error, and the mark is the ratchet", async () => {
  const { root, config } = await createRepository();
  await writeNode(root, {
    id: "mechanism.approval-command",
    level: "mechanism",
    statement: "An application *command* performs approval.",
    constrainedBy: ["architecture.approval-owner"],
    sync: { constraintsDigest: "pending" },
    implementation: { files: ["src/approve.ts", "test/approve.test.ts"], digest: "pending" },
  });
  const status = await inspectWorkingTree(config);
  const missing = status.validation.diagnostics.find((item) => item.code === "PL1307 MISSING_TERM");
  assert.ok(missing, "marking nothing is legal; the moment you mark, you owe the declaration");
  assert.equal(missing.nodeId, "mechanism.approval-command");
  assert.match(missing.message, /\*command\*/);
});

test("a declared and marked term validates, and sync writes the vocabulary digest", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await writeNode(root, {
    id: "product.current-version",
    level: "product",
    statement: "Each shot has one current *version*.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.equal(sync.diagnostics.length, 0);
  await git(root, "add", "docs");

  const node = await readNode(root, "product", "current-version");
  assert.match(node.sync.vocabularyDigest, /^sha256:product-lint-vocabulary-v1:/);
  // A node that marks nothing carries no vocabulary digest, so the other 87
  // files of an adopting repository stay byte-identical.
  const silent = await readNode(root, "behavior", "approve-version");
  assert.equal("vocabularyDigest" in silent.sync, false);
  // A term whose definition marks nothing carries no sync at all.
  const declared = await readTerm(root, "product", "version");
  assert.equal("sync" in declared, false);

  const status = await inspectWorkingTree(config);
  assert.equal(status.validation.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(status.synchronization.length, 0);
});

test("changing a definition invalidates the statements that mark the term", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await writeNode(root, {
    id: "product.current-version",
    level: "product",
    statement: "Each shot has one current *version*.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", "docs");
  await synchronizeStaged(config);
  await git(root, "add", "docs");

  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one rendition a reviewer may approve.",
  });
  const status = await inspectWorkingTree(config);
  const stale = status.synchronization.find((item) => item.code === "PL2004 STALE_VOCABULARY");
  assert.ok(stale, "the statement's meaning depends on the definition, exactly as on a parent");
  assert.equal(stale.nodeId, "product.current-version");

  await git(root, "add", "docs");
  const repaired = await synchronizeStaged(config);
  assert.ok(repaired.updatedFiles.includes("docs/product/current-version.json"));
});

test("a definition marking another term is synchronized and cascades", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await writeTerm(root, {
    id: "term.delivery",
    level: "product",
    name: "delivery",
    definition: "A delivery is the *version* a studio sends to a client.",
  });
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.equal(sync.diagnostics.length, 0);
  await git(root, "add", "docs");
  const delivery = await readTerm(root, "product", "delivery");
  assert.match(delivery.sync.vocabularyDigest, /^sha256:product-lint-vocabulary-v1:/);

  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one rendition a reviewer may approve.",
  });
  const status = await inspectWorkingTree(config);
  const stale = status.synchronization.find(
    (item) => item.code === "PL2004 STALE_VOCABULARY" && item.nodeId === "term.delivery",
  );
  assert.ok(stale, "a definition that speaks a word depends on it the way a statement does");
});

test("vocabulary flows down only: a statement cannot mark a deeper term", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.rung",
    level: "behavior",
    name: "rung",
    definition: "A rung is one fixed time on the day's ladder.",
  });
  await writeNode(root, {
    id: "product.current-version",
    level: "product",
    statement: "Each shot has one current version on its *rung*.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  const status = await inspectWorkingTree(config);
  const below = status.validation.diagnostics.find((item) => item.code === "PL1308 TERM_FROM_BELOW");
  assert.ok(below);
  assert.equal(below.nodeId, "product.current-version");
  assert.match(below.message, /declared at behavior/);
});

test("one name has one thing, across levels and case", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.plan",
    level: "product",
    name: "plan",
    definition: "A plan is the set of doable tasks that resolves an ambiguous task.",
  });
  await writeTerm(root, {
    id: "term.retain-plan",
    level: "behavior",
    name: "Plan",
    definition: "A plan is the schedule of proofs for the topics a member keeps.",
  });
  const status = await inspectWorkingTree(config);
  const duplicate = status.validation.diagnostics.find(
    (item) => item.code === "PL1304 DUPLICATE_TERM_NAME",
  );
  assert.ok(duplicate, "a reader resolves *plan* without knowing what level they are on");
  const annotated = annotateDiagnostic(duplicate);
  assert.match(annotated.fix, /two-word name/);
});

test("audience and context declare no terms", async () => {
  const { root, config } = await createRepository();
  const file = path.join(root, "docs", "context", "terms", "problem.json");
  await writeTerm(root, {
    id: "term.problem",
    level: "context",
    name: "problem",
    definition: "A problem is what a member brings before the product exists.",
  }).catch(() => {});
  // writeTerm derives the folder from level, so write the forbidden file directly.
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ schemaVersion: 1, id: "term.problem", level: "context", name: "problem", definition: "x" }, null, 2)}\n`,
  );
  const status = await inspectWorkingTree(config);
  const forbidden = status.validation.diagnostics.find(
    (item) => item.code === "PL1309 TERM_LEVEL_FORBIDDEN",
  );
  assert.ok(forbidden);
  assert.match(forbidden.message, /world's words/);
});

test("a malformed mark is an error, not a silent non-mark", async () => {
  const { root, config } = await createRepository();
  await writeNode(root, {
    id: "product.current-version",
    level: "product",
    statement: "Each shot has one current *version.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  const status = await inspectWorkingTree(config);
  assert.ok(
    status.validation.diagnostics.some((item) => item.code === "PL1311 MALFORMED_TERM_MARK"),
  );
});

// --- The commit path ---

test("a definition change demands its dependents staged and its own trailer", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await writeNode(root, {
    id: "product.current-version",
    level: "product",
    statement: "Each shot has one current *version*.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", "docs");
  await synchronizeStaged(config);
  await git(root, "add", "docs");
  await git(root, "commit", "-qm", "seed vocabulary");

  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one rendition a reviewer may approve.",
  });
  await git(root, "add", "docs/product/terms");
  const unstaged = await checkStagedCommit(config);
  const dependent = unstaged.diagnostics.find(
    (item) => item.code === "PL2103 STALE_DEPENDENT" && item.nodeId === "product.current-version",
  );
  assert.ok(dependent, "every text that speaks the word must be re-read, so it must be staged");
  assert.equal(dependent.details.changedNode, "term.version");

  await synchronizeStaged(config);
  await git(root, "add", "docs");
  const staged = await checkStagedCommit(config);
  assert.equal(hasErrors(staged.diagnostics), false);
  assert.ok(staged.nodeChanges.semantic.has("term.version"));
  assert.equal(
    staged.nodeChanges.semantic.has("product.current-version"),
    false,
    "the node's rewrite is synchronization, not a claim change",
  );

  const messageFile = path.join(root, "message.txt");
  await writeFile(messageFile, "change the meaning of a version\n\nBecause approval needs it.\n");
  const noTrailer = await checkCommitMessage(config, messageFile);
  const missing = noTrailer.diagnostics.find((item) => item.code === "PL2202 MISSING_KNOWLEDGE_TRAILER");
  assert.ok(missing);
  assert.equal(missing.nodeId, "term.version");

  await writeFile(
    messageFile,
    "change the meaning of a version\n\nBecause approval needs it.\n\nKnowledge-Change: term.version\n",
  );
  const withTrailer = await checkCommitMessage(config, messageFile);
  assert.equal(hasErrors(withTrailer.diagnostics), false);
});

test("commit check reports unmarked candidates only for the statements in the diff", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await git(root, "add", "docs");
  await git(root, "commit", "-qm", "declare a term");

  // The seeded product statement also says "version", but it is not in this
  // diff — the standing backlog stays in `product-lint vocabulary`.
  await writeNode(root, {
    id: "mechanism.approval-command",
    level: "mechanism",
    statement: "An application command approves one version.",
    constrainedBy: ["architecture.approval-owner"],
    sync: { constraintsDigest: "pending" },
    implementation: { files: ["src/approve.ts", "test/approve.test.ts"], digest: "pending" },
  });
  await git(root, "add", "docs");
  await synchronizeStaged(config);
  await git(root, "add", "docs");

  const result = await checkStagedCommit(config);
  const unmarked = result.diagnostics.find((item) => item.code === "PL0801 UNMARKED_TERM_USE");
  assert.ok(unmarked, "the one moment the mark costs two characters in a file already open");
  assert.deepEqual(
    unmarked.details.uses.map((use) => use.id),
    ["mechanism.approval-command"],
  );
  assert.equal(hasErrors(result.diagnostics), false, "info reports, never gates");
});

// --- The report: judgement calls, grouped, level-scoped ---

test("unmarked uses group by term, skip shallower levels, and skip verb forms", () => {
  const nodes = sourced([
    ...canonicalNodes(),
    {
      id: "context.planning-hurts",
      level: "context",
      statement: "Building a plan costs more than following it.",
      constrainedBy: ["audience.role.reviewer"],
    },
    {
      id: "product.approved-plan",
      level: "product",
      statement: "Only a plan the member approves finishes the work.",
      constrainedBy: ["context.review-problem"],
    },
    {
      id: "behavior.plans-are-kept",
      level: "behavior",
      statement: "A reviewer sees the plans they approved.",
      constrainedBy: ["product.current-version"],
    },
    {
      id: "behavior.planned-work",
      level: "behavior",
      statement: "The digest lists what was planned beside what was not.",
      constrainedBy: ["product.current-version"],
    },
    {
      id: "behavior.marked-already",
      level: "behavior",
      statement: "A member approves the *plan* before it runs.",
      constrainedBy: ["product.current-version"],
    },
  ]);
  const terms = [
    term({
      id: "term.plan",
      name: "plan",
      definition: "A plan is the set of doable tasks that resolves one ambiguous task.",
      sourcePath: "docs/product/terms/plan.json",
    }),
  ];
  const diagnostics = unmarkedUseDiagnostics(nodes, terms);
  assert.equal(diagnostics.length, 1, "one block per term, the way a long file list folds into a tree");
  const uses = diagnostics[0].details.uses.map((use) => use.id).sort();
  assert.deepEqual(uses, ["behavior.plans-are-kept", "product.approved-plan"]);
  // Context speaks the world's words; "planned" is a verb cousin; a marked use
  // is already resolved. None of the three is a candidate.
  const text = formatDiagnostic(diagnostics[0]);
  assert.match(text, /uses \(2\):/);
  assert.match(text, /Three readings/);
});

test("two definitions written in the same words are a synonym candidate", () => {
  const terms = [
    term({
      id: "term.rung",
      name: "rung",
      definition: "One of the fixed times the day offers for work.",
      sourcePath: "docs/behavior/terms/rung.json",
      level: "behavior",
    }),
    term({
      id: "term.slot",
      name: "slot",
      definition: "One of the fixed times the day offers for a task.",
      sourcePath: "docs/behavior/terms/slot.json",
      level: "behavior",
    }),
    term({
      id: "term.digest",
      name: "digest",
      definition: "The evening account of what the member finished.",
      sourcePath: "docs/behavior/terms/digest.json",
      level: "behavior",
    }),
  ];
  const diagnostics = synonymCandidateDiagnostics(terms);
  assert.equal(diagnostics.length, 1);
  assert.match(diagnostics[0].message, /term\.rung and term\.slot/);
  assert.match(diagnostics[0].message, /Two words may be one thing/);
});

test("a mid-sentence capital with no declaration is the migration seed", () => {
  const nodes = sourced([
    {
      id: "product.one-kind",
      level: "product",
      statement: "The system gives every source one Kind and never two.",
      constrainedBy: ["context.review-problem"],
    },
    {
      id: "product.wont-do",
      level: "product",
      statement: "A task leaves the day when it becomes Won't Do, and never by disappearing.",
      constrainedBy: ["context.review-problem"],
    },
    {
      id: "behavior.quoted-literal",
      level: "behavior",
      statement: "The digest lists work under 'Completed — unplanned', beside the rest.",
      constrainedBy: ["product.current-version"],
    },
  ]);
  const diagnostics = capitalizedUndeclaredDiagnostics(nodes, buildVocabulary([]));
  const words = diagnostics.map((item) => item.details.word).sort();
  assert.deepEqual(words, ["Kind", "Won't Do"], "quoted spans are surface literals, not candidates");
});

test("declared capitals are not re-seeded", () => {
  const nodes = sourced([
    {
      id: "product.one-kind",
      level: "product",
      statement: "The system gives every source one Kind and never two.",
      constrainedBy: ["context.review-problem"],
    },
  ]);
  const vocabulary = buildVocabulary([term({ id: "term.kind", name: "Kind" })]);
  assert.equal(capitalizedUndeclaredDiagnostics(nodes, vocabulary).length, 0);
});

test("a declaration nothing marks, and one no statement at its level marks, are reported", () => {
  const nodes = sourced([
    ...canonicalNodes().slice(0, 3),
    {
      id: "behavior.deep-use",
      level: "behavior",
      statement: "A reviewer opens the *ledger* for a shot.",
      constrainedBy: ["product.current-version"],
    },
  ]);
  const terms = [
    term({ id: "term.orphan", name: "orphan", definition: "A thing nothing speaks of." }),
    term({ id: "term.ledger", name: "ledger", definition: "The record of every approval." }),
  ];
  const diagnostics = unusedTermDiagnostics(nodes, terms);
  assert.ok(diagnostics.some((item) => item.code === "PL0804 UNUSED_TERM" && item.nodeId === "term.orphan"));
  assert.ok(
    diagnostics.some(
      (item) => item.code === "PL0805 TERM_UNUSED_AT_ITS_LEVEL" && item.nodeId === "term.ledger",
    ),
    "declared at product, first marked use at behavior",
  );
});

test("the staged report reads a changed term against everything, an unchanged term against the diff", () => {
  const nodes = sourced([
    {
      id: "product.approved-plan",
      level: "product",
      statement: "Only a plan the member approves finishes the work.",
      constrainedBy: ["context.review-problem"],
    },
    {
      id: "behavior.version-shown",
      level: "behavior",
      statement: "A reviewer sees which version is current.",
      constrainedBy: ["product.approved-plan"],
    },
  ]);
  const terms = [
    term({ id: "term.plan", name: "plan", definition: "A plan is the set of doable tasks that resolves one ambiguous task.", sourcePath: "docs/product/terms/plan.json" }),
    term(),
  ];
  const changedPaths = new Set(["docs/product/terms/plan.json"]);
  const scoped = vocabularyReport(nodes, terms, { changedPaths });
  const codes = scoped.diagnostics.map((item) => `${item.code} ${item.nodeId ?? ""}`);
  assert.ok(codes.some((code) => code.startsWith("PL0801 UNMARKED_TERM_USE term.plan")));
  assert.ok(
    !codes.some((code) => code.includes("term.version")),
    "the version candidate is backlog: neither the term nor the statement is in this diff",
  );
});

// --- Surfaces ---

test("a frontier diagnostic shows the terms in scope, and prints them", async () => {
  const { root } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await writeNode(root, {
    id: "product.second-rule",
    level: "product",
    statement: "A second product rule with nothing under it yet.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  const status = await inspectWorkingTree(await loadConfig(root));
  const missing = status.frontier.diagnostics.find(
    (item) => item.code === "PL0201 MISSING_BEHAVIOR" && item.frontier === "product.second-rule",
  );
  assert.ok(missing);
  assert.equal(missing.details.termsInScope.total, 1);
  const text = formatDiagnostic(missing);
  assert.match(text, /terms in scope at behavior \(1\):/);
  assert.match(text, /\*version\* — term\.version \(product\)/);
  assert.match(text, /vocabulary: /, "the rule and the set it refers to arrive together");
});

test("the llms view carries the definitions of the terms on the page, and the fourth rule", () => {
  const nodes = sourced(canonicalNodes());
  nodes[2] = { ...nodes[2], statement: "Each shot has one current *version*." };
  const graph = buildKnowledgeGraph(nodes).graph;
  const terms = [term()];
  const text = renderFileKnowledgeForLlm(knowledgeForFile(graph, [], "src/approve.ts"), terms);
  assert.match(text, /# Terms/);
  assert.match(text, /## term\.version/);
  assert.match(text, /definition: A version is one uploaded rendition of a shot\./);
  assert.match(text, /# If you use or coin a term/);
  assert.match(text, /A marked word is a defined term/);
});

test("a lineage that marks nothing gets the rule but no terms section", () => {
  const graph = buildKnowledgeGraph(sourced(canonicalNodes())).graph;
  const text = renderFileKnowledgeForLlm(knowledgeForFile(graph, [], "src/approve.ts"), [term()]);
  assert.doesNotMatch(text, /# Terms/);
  assert.match(text, /# If you use or coin a term/);
});

test("affected-by a term lists every text that speaks the word", () => {
  const nodes = sourced(canonicalNodes());
  nodes[2] = { ...nodes[2], statement: "Each shot has one current *version*." };
  const terms = [
    term(),
    term({
      id: "term.delivery",
      name: "delivery",
      definition: "A delivery is the *version* a studio sends to a client.",
      sourcePath: "docs/product/terms/delivery.json",
    }),
  ];
  const result = affectedByTerm(nodes, terms, "term.version");
  assert.deepEqual(result.nodes.map((node) => node.id), ["product.current-version"]);
  assert.deepEqual(result.terms.map((item) => item.id), ["term.delivery"]);
  assert.throws(() => affectedByTerm(nodes, terms, "term.missing"), /Unknown term/);
});
