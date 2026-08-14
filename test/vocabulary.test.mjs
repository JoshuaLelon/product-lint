// Vocabulary: terms declared where they are first needed, uses marked in
// prose, and the two failure modes the graph's own context node names —
// merging what differs, or keeping two records of the same thing. The
// decidable half is enforced; the judgement half is reported and a human
// decides, in the spirit of `contested`.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
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
  recordRejection,
  rejectedNameDiagnostics,
  rejectedNameUseDiagnostics,
  renderFileKnowledgeForLlm,
  resolveMark,
  semanticTermFingerprint,
  serializeTermNode,
  termFingerprint,
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
    rejected: [],
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
  assert.match(VOCABULARY_RULE, /Every level may declare/);
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

// --- Every level declares ---
//
// A term may now be coined at any level, context and audience included. The
// argument that kept them out — a coined noun cannot appear in a statement
// that stays true if you build nothing — is about where a word may be SPOKEN,
// and PL1308 is what enforces it. These tests hold the two halves apart:
// coining widened, speaking did not.

test("a context term is declared, marked at context, and marked deeper", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.bloat",
    level: "context",
    name: "bloat",
    definition: "Bloat is information in front of a member that the member does not want.",
  });
  await writeNode(root, {
    id: "context.review-problem",
    level: "context",
    statement: "Video teams lose track of review state under *bloat*.",
    constrainedBy: ["audience.role.reviewer"],
    sync: { constraintsDigest: "pending" },
  });
  await writeNode(root, {
    id: "product.current-version",
    level: "product",
    statement: "Each shot has one current version, so its history is not *bloat*.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.equal(sync.diagnostics.length, 0);
  await git(root, "add", "docs");

  const status = await inspectWorkingTree(config);
  assert.equal(status.validation.diagnostics.filter((item) => item.severity === "error").length, 0);
  assert.equal(status.synchronization.length, 0);

  // The digest is the half most likely to have been written for four levels:
  // a context node carries vocabulary state exactly as a product node does,
  // validate reads it back, and a second sync is a no-op.
  const problem = await readNode(root, "context", "review-problem");
  const version = await readNode(root, "product", "current-version");
  assert.match(problem.sync.vocabularyDigest, /^sha256:product-lint-vocabulary-v1:/);
  assert.equal(
    version.sync.vocabularyDigest,
    problem.sync.vocabularyDigest,
    "both statements speak one word, so both carry one digest",
  );
  const again = await synchronizeStaged(config);
  assert.deepEqual(again.updatedFiles, []);
});

test("a product term marked in a context statement is still an error", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  await writeNode(root, {
    id: "context.review-problem",
    level: "context",
    statement: "Video teams lose track of the current *version*.",
    constrainedBy: ["audience.role.reviewer"],
    sync: { constraintsDigest: "pending" },
  });
  const status = await inspectWorkingTree(config);
  const below = status.validation.diagnostics.find((item) => item.code === "PL1308 TERM_FROM_BELOW");
  assert.ok(below, "the previously impossible case is now reachable, and still refused");
  assert.equal(below.nodeId, "context.review-problem");
  assert.match(below.message, /declared at product/);
});

test("a context term's unmarked uses start at context and skip audience", () => {
  const nodes = sourced([
    ...canonicalNodes(),
    {
      id: "audience.role.editor",
      level: "audience",
      statement: "The product serves people who cut bloat from a timeline.",
      constrainedBy: [],
    },
    {
      id: "context.stale-lists",
      level: "context",
      statement: "A list that no longer describes today is bloat a member reads past.",
      constrainedBy: ["audience.role.reviewer"],
    },
    {
      id: "product.one-list",
      level: "product",
      statement: "A member keeps one list, so a second list is bloat.",
      constrainedBy: ["context.review-problem"],
    },
  ]);
  const terms = [
    term({
      id: "term.bloat",
      level: "context",
      name: "bloat",
      definition: "Bloat is information in front of a member that the member does not want.",
      sourcePath: "docs/context/terms/bloat.json",
    }),
  ];
  const diagnostics = unmarkedUseDiagnostics(nodes, terms);
  assert.equal(diagnostics.length, 1);
  const uses = diagnostics[0].details.uses.map((use) => use.id).sort();
  // The walk starts at the term's own level, wherever that is. Audience is
  // shallower and cannot mark it, so the word there is a different word.
  assert.deepEqual(uses, ["context.stale-lists", "product.one-list"]);
  assert.match(diagnostics[0].message, /term\.bloat's level or deeper/);
});

test("one name has one thing, across the widened levels too", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.bloat",
    level: "context",
    name: "bloat",
    definition: "Bloat is information in front of a member that the member does not want.",
  });
  await writeTerm(root, {
    id: "term.feed-bloat",
    level: "product",
    name: "Bloat",
    definition: "Bloat is the share of a feed the product declines to rank.",
  });
  const status = await inspectWorkingTree(config);
  const duplicate = status.validation.diagnostics.find(
    (item) => item.code === "PL1304 DUPLICATE_TERM_NAME",
  );
  assert.ok(duplicate, "one declaration per name did not become one per level");
  assert.deepEqual(duplicate.details.terms.sort(), ["term.bloat", "term.feed-bloat"]);
});

test("an audience term is declared and marked like any other", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.shot-reviewer",
    level: "audience",
    name: "shot reviewer",
    definition: "A shot reviewer is a person who decides whether a shot may reach a client.",
  });
  await writeNode(root, {
    id: "audience.role.reviewer",
    level: "audience",
    statement: "The product serves a *shot reviewer*.",
    constrainedBy: [],
    sync: { constraintsDigest: "pending" },
  });
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.equal(sync.diagnostics.length, 0);
  await git(root, "add", "docs");
  const status = await inspectWorkingTree(config);
  assert.equal(status.validation.diagnostics.filter((item) => item.severity === "error").length, 0);
  const role = await readNode(root, "audience", "role-reviewer");
  assert.match(role.sync.vocabularyDigest, /^sha256:product-lint-vocabulary-v1:/);
});

test("an audience term nothing at audience marks is reported, not refused", () => {
  const nodes = sourced([
    ...canonicalNodes().filter((node) => node.id !== "product.current-version"),
    {
      id: "product.current-version",
      level: "product",
      statement: "Each shot a *crew* uploads has one current version.",
      constrainedBy: ["context.review-problem"],
    },
  ]);
  const crew = term({
    id: "term.crew",
    level: "audience",
    name: "crew",
    definition: "A crew is the set of people who work one production together.",
    sourcePath: "docs/audience/terms/crew.json",
  });
  const diagnostics = unusedTermDiagnostics(nodes, [crew]);
  // This is the guard the level list used to be, and it is a better one: it
  // answers per graph what an enum could only answer per tool.
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].code, "PL0805 TERM_UNUSED_AT_ITS_LEVEL");
  assert.match(diagnostics[0].message, /declared at audience/);
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
  // The context node is above a product term and could not mark it; "planned"
  // is a verb cousin; a marked use is already resolved. None is a candidate.
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

// --- Borrowed words and the names that lost ---
//
// A naming decision leaves no trace by default: you weigh three words, pick
// one, and the only evidence is that a different word is present. These tests
// hold the two halves of the repair — where a word came from, and what it beat.

test("a term records where its word came from, and rejections it weighed", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.bloat",
    level: "context",
    name: "bloat",
    definition: "Bloat is information in front of a member that the member does not want.",
    borrowed:
      "Low precision, from information retrieval. Precision is a metric on a result set; bloat names its failure state as something a member meets.",
    rejected: [
      {
        name: "noise",
        stance: "wrong",
        because: "Shannon's signal-to-noise is about transmission, not relevance.",
      },
      {
        name: "gap",
        stance: "taken",
        because: "Already load-bearing for a deficit in what a member understands.",
      },
    ],
  });
  const status = await inspectWorkingTree(config);
  assert.equal(hasErrors(status.validation.diagnostics), false);
  const stored = status.validation.terms.find((item) => item.id === "term.bloat");
  assert.match(stored.borrowed, /information retrieval/);
  assert.deepEqual(stored.rejected.map((item) => `${item.name}:${item.stance}`), [
    "noise:wrong",
    "gap:taken",
  ]);
});

test("rejected is required, and the empty list is the answer when nothing was weighed", async () => {
  const { root, config } = await createRepository();
  const file = await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  const withoutField = JSON.parse(await readFile(file, "utf8"));
  delete withoutField.rejected;
  await writeFile(file, `${JSON.stringify(withoutField, null, 2)}\n`, "utf8");
  const missing = await inspectWorkingTree(config);
  const diagnostic = missing.validation.diagnostics.find(
    (item) => item.code === "PL1301 INVALID_TERM",
  );
  assert.ok(diagnostic, "an absent list and an empty one must not be the same byte");
  assert.match(diagnostic.message, /missing "rejected"/);

  // The distinction the requirement buys: [] says nothing was weighed, where
  // silence used to say only that nobody wrote it down.
  await writeFile(file, `${JSON.stringify({ ...withoutField, rejected: [] }, null, 2)}\n`, "utf8");
  const empty = await inspectWorkingTree(config);
  assert.equal(hasErrors(empty.validation.diagnostics), false);
});

test("a rejection carries a reason, a known stance, and never the term's own name", async () => {
  const { root, config } = await createRepository();
  const file = await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  const base = JSON.parse(await readFile(file, "utf8"));
  const cases = [
    [{ name: "render", stance: "wrong" }, /non-empty because/],
    [{ name: "render", stance: "maybe", because: "Unsure." }, /Invalid rejection stance/],
    [{ name: "Version", stance: "wrong", because: "Circular." }, /cannot reject its own name/],
  ];
  for (const [rejection, pattern] of cases) {
    await writeFile(file, `${JSON.stringify({ ...base, rejected: [rejection] }, null, 2)}\n`, "utf8");
    const status = await inspectWorkingTree(config);
    const diagnostic = status.validation.diagnostics.find(
      (item) => item.code === "PL1301 INVALID_TERM",
    );
    assert.ok(diagnostic, `no diagnostic for ${JSON.stringify(rejection)}`);
    assert.match(diagnostic.message, pattern);
  }
});

test("a name another term rejected as wrong cannot be declared", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.bloat",
    level: "context",
    name: "bloat",
    definition: "Bloat is information in front of a member that the member does not want.",
    rejected: [
      {
        name: "clutter",
        stance: "wrong",
        because: "Names how the screen looks, not what the member did not want.",
      },
    ],
  });
  await writeTerm(root, {
    id: "term.clutter",
    level: "product",
    name: "clutter",
    definition: "Clutter is the share of a list the product declines to rank.",
  });
  const status = await inspectWorkingTree(config);
  const diagnostic = status.validation.diagnostics.find(
    (item) => item.code === "PL1312 REJECTED_TERM_NAME",
  );
  assert.ok(diagnostic);
  assert.equal(diagnostic.severity, "error");
  // Named on the declaration, because that is the file with a name to change.
  assert.equal(diagnostic.nodeId, "term.clutter");
  assert.equal(diagnostic.details.rejectedBy.id, "term.bloat");
  assert.match(diagnostic.message, /Names how the screen looks/);
  // The repair is PL1304's repair, not deletion — a rejection deleted to quiet
  // the linter destroys the record the field exists to keep.
  const text = formatDiagnostic(diagnostic);
  assert.match(text, /two-word name/);
});

test("the collision is global and order-independent, the way PL1304 is", () => {
  const rejecting = term({
    id: "term.bloat",
    level: "context",
    name: "bloat",
    definition: "Bloat is information in front of a member that the member does not want.",
    sourcePath: "docs/context/terms/bloat.json",
    rejected: [{ name: "Clutter", stance: "wrong", because: "Names the screen, not the want." }],
  });
  const declaring = term({
    id: "term.clutter",
    level: "mechanism",
    name: "clutter",
    definition: "Clutter is the node count a view refuses to exceed.",
    sourcePath: "docs/mechanism/terms/clutter.json",
  });
  // Marks resolve globally, so a level-scoped rejection would be incoherent
  // with the notation: the mechanism declaration collides with a context
  // rejection, and the case of the first letter does not save it.
  const forward = rejectedNameDiagnostics([rejecting, declaring]);
  const reverse = rejectedNameDiagnostics([declaring, rejecting]);
  assert.equal(forward.length, 1);
  assert.deepEqual(forward, reverse, "the finding must not depend on which file was read first");
});

test("a taken rejection is recorded and never enforced", () => {
  const rejecting = term({
    id: "term.fracture",
    level: "context",
    name: "fracture",
    definition: "Fracture is what a member wanted and did not meet, its absence unseen.",
    sourcePath: "docs/context/terms/fracture.json",
    rejected: [
      {
        name: "gap",
        stance: "taken",
        because: "Already load-bearing for a deficit in what a member understands.",
      },
    ],
  });
  const declaring = term({
    id: "term.gap",
    level: "product",
    name: "gap",
    definition: "A gap is a deficit in what a member understands about a topic.",
    sourcePath: "docs/product/terms/gap.json",
  });
  // The declaration is what the rejection PREDICTED. Reporting it would fire on
  // the case the note was written to describe, and the only clean repair would
  // be deleting a true record. PL1304 still catches any real name collision.
  assert.deepEqual(rejectedNameDiagnostics([rejecting, declaring]), []);

  const nodes = sourced([
    {
      id: "product.closes-a-gap",
      level: "product",
      statement: "The system closes a gap with content the member already holds.",
      constrainedBy: [],
    },
  ]);
  assert.deepEqual(rejectedNameUseDiagnostics(nodes, [rejecting]), []);
});

test("a wrong rejection is scanned in prose, at its level or deeper", () => {
  const nodes = sourced([
    {
      id: "audience.role.member",
      level: "audience",
      statement: "Clutter is what people who keep lists complain about.",
      constrainedBy: [],
    },
    {
      id: "context.stale-lists",
      level: "context",
      statement: "Clutter on the day view costs a member the task they opened it for.",
      constrainedBy: [],
    },
    {
      id: "product.one-list",
      level: "product",
      statement: 'The system labels the control "Hide clutter" and removes the rest.',
      constrainedBy: [],
    },
    {
      id: "behavior.marked",
      level: "behavior",
      statement: "A member meets less clutter than the system knows about.",
      constrainedBy: [],
    },
  ]);
  const terms = [
    term({
      id: "term.bloat",
      level: "context",
      name: "bloat",
      definition: "Bloat is information in front of a member that the member does not want.",
      sourcePath: "docs/context/terms/bloat.json",
      rejected: [
        {
          name: "clutter",
          stance: "wrong",
          because: "Names how the screen looks, not what the member did not want.",
        },
      ],
    }),
  ];
  const diagnostics = rejectedNameUseDiagnostics(nodes, terms);
  assert.equal(diagnostics.length, 1, "one block per rejection, the way PL0801 folds per term");
  assert.equal(diagnostics[0].severity, "info");
  const uses = diagnostics[0].details.uses.map((use) => use.id).sort();
  // Audience is shallower than the term and could not mark it; the quoted
  // surface literal is a screen's word, not a candidate.
  assert.deepEqual(uses, ["behavior.marked", "context.stale-lists"]);
  assert.match(formatDiagnostic(diagnostics[0]), /uses \(2\):/);
});

test("an origin and a rejection do not restate the statements that speak the word", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
  });
  const node = await readNode(root, "product", "current-version");
  await writeNode(root, { ...node, statement: "Each shot has one current *version*." });
  await git(root, "add", ".");
  await synchronizeStaged(config);
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "docs: mark the version uses\n\nKnowledge-Change: product.current-version");

  const before = (await inspectWorkingTree(config)).validation.terms.find(
    (item) => item.id === "term.version",
  );
  const after = {
    ...before,
    borrowed: "Revision, from version control. Ours is an uploaded rendition rather than a commit.",
    rejected: [{ name: "cut", stance: "wrong", because: "An editing word, not an upload." }],
  };
  // The line the retrofit depends on: attaching an origin to an existing word
  // changes no statement's meaning, so it must not go stale downstream. A pass
  // over seventy terms that restated thirteen files each would not get done.
  assert.equal(semanticTermFingerprint(before), semanticTermFingerprint(after));
  assert.notEqual(termFingerprint(before), termFingerprint(after));

  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: before.definition,
    borrowed: after.borrowed,
    rejected: after.rejected,
  });
  const status = await inspectWorkingTree(config);
  assert.equal(
    status.synchronization.some((item) => item.code === "PL2004 STALE_VOCABULARY"),
    false,
    "an origin is not a change of meaning",
  );
  // Editing the definition still propagates, which is the half that must stay.
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one rendition a reviewer may approve.",
    rejected: [],
  });
  const edited = await inspectWorkingTree(config);
  assert.ok(
    edited.synchronization.some(
      (item) => item.code === "PL2004 STALE_VOCABULARY" && item.nodeId === "product.current-version",
    ),
    "a definition change must still reach every statement that speaks the word",
  );
});

test("both reader surfaces carry the words already weighed", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.version",
    level: "product",
    name: "version",
    definition: "A version is one uploaded rendition of a shot.",
    borrowed: "Revision, from version control. Ours is an upload rather than a commit.",
    rejected: [{ name: "cut", stance: "wrong", because: "An editing word, not an upload." }],
  });
  await writeNode(root, {
    id: "product.second-rule",
    level: "product",
    statement: "A second product rule with nothing under it yet.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  const status = await inspectWorkingTree(config);
  const missing = status.frontier.diagnostics.find(
    (item) => item.code === "PL0201 MISSING_BEHAVIOR" && item.frontier === "product.second-rule",
  );
  // Scanned to answer "does a word for this exist already", so names and
  // stances, and the reasons stay one file away.
  const frontierText = formatDiagnostic(missing);
  assert.match(frontierText, /borrowed: Revision, from version control/);
  assert.match(frontierText, /rejected: cut \(wrong\)/);
  assert.doesNotMatch(frontierText, /An editing word/);

  // Edited from, so the reason in full — what an agent needs to argue with a
  // rejection rather than merely avoid the word.
  const nodes = sourced(canonicalNodes());
  nodes[2] = { ...nodes[2], statement: "Each shot has one current *version*." };
  const graph = buildKnowledgeGraph(nodes).graph;
  const llmText = renderFileKnowledgeForLlm(
    knowledgeForFile(graph, [], "src/approve.ts"),
    status.validation.terms,
  );
  assert.match(llmText, /borrowed: Revision, from version control/);
  assert.match(llmText, /rejected: cut \(wrong\) — An editing word, not an upload\./);
  assert.match(VOCABULARY_RULE, /Record the names you weighed and passed on/);
});

// --- Recording a loser after the fact ---
//
// Required `rejected` reaches one moment, the term's creation. Alternatives are
// usually weighed later, about a term declared months ago and not open — and a
// recording that costs more than the decision does not happen.

test("a rejection can be recorded on a term that is not being edited", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.rung",
    level: "behavior",
    name: "rung",
    definition: "A rung is one fixed time the day offers for work.",
  });
  const terms = (await inspectWorkingTree(config)).validation.terms;
  const result = recordRejection(terms, "term.rung", {
    name: "cadence",
    stance: "wrong",
    because: "Names the tempo, not the slot.",
  });
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.term.rejected, [
    { name: "cadence", stance: "wrong", because: "Names the tempo, not the slot." },
  ]);
  // Written through the same serializer the rest of the tool uses, so the file
  // a command touches and the file a human writes are the same shape.
  const text = serializeTermNode(result.term);
  assert.equal(JSON.parse(text).rejected.length, 1);
  assert.throws(() => recordRejection(terms, "term.missing", {
    name: "x", stance: "wrong", because: "y",
  }), /Unknown term/);
});

test("the write is refused with the diagnostic it would have caused", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.rung",
    level: "behavior",
    name: "rung",
    definition: "A rung is one fixed time the day offers for work.",
    rejected: [{ name: "cadence", stance: "wrong", because: "Names the tempo, not the slot." }],
  });
  await writeTerm(root, {
    id: "term.slot",
    level: "behavior",
    name: "slot",
    definition: "A slot is a span a member holds for one task.",
  });
  const terms = (await inspectWorkingTree(config)).validation.terms;
  const refusals = [
    [{ name: "rung", stance: "wrong", because: "Circular." }, "PL1301 INVALID_TERM", /own name/],
    [{ name: "cadence", stance: "taken", because: "Second thought." }, "PL1301 INVALID_TERM", /already rejected/],
    [{ name: "  ", stance: "wrong", because: "Nameless." }, "PL1301 INVALID_TERM", /non-empty name/],
    [{ name: "beat", stance: "wrong", because: "  " }, "PL1301 INVALID_TERM", /non-empty because/],
    // The collision named before the file changes rather than one second later,
    // and the message carries the stance that is the repair.
    [{ name: "slot", stance: "wrong", because: "Not the same." }, "PL1312 REJECTED_TERM_NAME", /taken stance instead/],
  ];
  for (const [rejection, code, pattern] of refusals) {
    const result = recordRejection(terms, "term.rung", rejection);
    assert.equal(result.term, undefined, `${rejection.name} was written anyway`);
    assert.equal(result.diagnostics[0].code, code);
    assert.match(result.diagnostics[0].message, pattern);
  }
  // A declared name is spoken for, not wrong, and that stance is allowed.
  const taken = recordRejection(terms, "term.rung", {
    name: "slot",
    stance: "taken",
    because: "Already load-bearing for a span a member holds.",
  });
  assert.deepEqual(taken.diagnostics, []);
  assert.equal(taken.term.rejected.length, 2);
});

test("the invalid-term repair names every required field", () => {
  const diagnostic = annotateDiagnostic({
    code: "PL1301 INVALID_TERM",
    severity: "error",
    message: "x",
  });
  assert.match(diagnostic.fix, /rejected/, "a repair that omits a required field is a wrong repair");
  assert.match(diagnostic.fix, /wrong or taken/);
});
