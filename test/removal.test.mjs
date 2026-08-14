import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  checkCommitMessage,
  checkStagedCommit,
  classifyDeletions,
  deletionDiagnostics,
  synchronizeStaged,
} from "../dist/index.js";
import { createRepository, git, writeNode, writeTerm } from "./_helpers.mjs";

function graphOf(nodes) {
  return {
    nodes: new Map(
      nodes.map((node) => [node.id, { sourcePath: `docs/${node.level}/${node.id}.json`, ...node }]),
    ),
  };
}

function changesOf(deleted, added) {
  return {
    semantic: new Set([...deleted, ...added]),
    synchronizationOnly: new Set(),
    deleted: new Set(deleted),
    added: new Set(added),
    changedPaths: new Map(),
  };
}

const COMMIT_CONFIG = {
  commit: {
    trailer: "Knowledge-Change",
    removedTrailer: "Knowledge-Removed",
    renamedTrailer: "Knowledge-Renamed",
    requireBody: true,
  },
};

function errors(diagnostics) {
  return diagnostics.filter((item) => item.severity === "error");
}

test("a statement that survives its rename pairs on the statement alone", () => {
  const head = graphOf([
    {
      id: "product.current-version",
      level: "product",
      statement: "Each shot has one current version.",
      constrainedBy: ["context.review-problem"],
    },
  ]);
  const staged = graphOf([
    {
      id: "product.selected-version",
      level: "product",
      statement: "Each shot has one selected version.",
      // Different parents on purpose: pass 1 needs no placement evidence.
      constrainedBy: ["context.other-problem"],
    },
  ]);
  const result = classifyDeletions(
    head,
    staged,
    [],
    [],
    changesOf(["product.current-version"], ["product.selected-version"]),
  );
  assert.equal(result.renames.length, 1);
  assert.equal(result.renames[0].basis, "statement");
  assert.ok(result.renames[0].similarity >= 0.5);
  assert.deepEqual(result.removals, []);
});

test("a rewritten statement pairs on identical parents plus a shared word", () => {
  const head = graphOf([
    {
      id: "mechanism.approval-command",
      level: "mechanism",
      statement: "Approval is implemented by an application command.",
      constrainedBy: ["architecture.approval-owner"],
    },
  ]);
  const staged = graphOf([
    {
      id: "mechanism.approval-handler",
      level: "mechanism",
      statement: "A single handler in the application layer performs every approval transition.",
      constrainedBy: ["architecture.approval-owner"],
    },
  ]);
  const result = classifyDeletions(
    head,
    staged,
    [],
    [],
    changesOf(["mechanism.approval-command"], ["mechanism.approval-handler"]),
  );
  assert.equal(result.renames.length, 1);
  assert.equal(result.renames[0].basis, "parents");
  assert.ok(result.renames[0].similarity < 0.5);
  assert.deepEqual(result.removals, []);
});

// The 81c8294 shape: greedy descending order lets the true rename take its
// partner at 0.80 before the accidental deletion — which shares the parent and
// the words "ambiguous" and "task" — ever reaches the bucket.
test("greedy ordering keeps an unrelated deletion from stealing a rename's partner", () => {
  const parent = ["context.the-clear-part-waits-on-the-unclear-part"];
  const head = graphOf([
    {
      id: "product.a-project-holds-at-most-one-open-ambiguous-task",
      level: "product",
      statement: "A project holds at most one open ambiguous task at a time.",
      constrainedBy: parent,
    },
    {
      id: "product.only-an-approved-plan-finishes-the-work",
      level: "product",
      statement: "Only a plan the member approves finishes the work of making an ambiguous task doable.",
      constrainedBy: parent,
    },
  ]);
  const staged = graphOf([
    {
      id: "product.only-an-approved-proposal-finishes-the-work",
      level: "product",
      statement: "Only a proposal the member approves finishes the work of making an ambiguous task doable.",
      constrainedBy: parent,
    },
  ]);
  const result = classifyDeletions(
    head,
    staged,
    [],
    [],
    changesOf(
      [
        "product.a-project-holds-at-most-one-open-ambiguous-task",
        "product.only-an-approved-plan-finishes-the-work",
      ],
      ["product.only-an-approved-proposal-finishes-the-work"],
    ),
  );
  assert.deepEqual(
    result.renames.map((pair) => [pair.deletedId, pair.addedId, pair.basis]),
    [
      [
        "product.only-an-approved-plan-finishes-the-work",
        "product.only-an-approved-proposal-finishes-the-work",
        "statement",
      ],
    ],
  );
  assert.deepEqual(result.removals, ["product.a-project-holds-at-most-one-open-ambiguous-task"]);
});

// The counterfactual that breaks the compositional luck above: the true rename
// lands in a different commit, so the accident meets its bucket-mate alone and
// pairs on placement plus a shared word. The pairing cannot be prevented
// without also breaking true restatements at 0.13 and 0.08 — so it must not
// pass silently: a parents-basis pair is a question, not a note.
test("a weak pairing is reported as a question, not a note", () => {
  const parent = ["context.the-clear-part-waits-on-the-unclear-part"];
  const head = graphOf([
    {
      id: "product.a-project-holds-at-most-one-open-ambiguous-task",
      level: "product",
      statement: "A project holds at most one open ambiguous task at a time.",
      constrainedBy: parent,
    },
  ]);
  const staged = graphOf([
    {
      id: "product.only-an-approved-proposal-finishes-the-work",
      level: "product",
      statement: "Only a proposal the member approves finishes the work of making an ambiguous task doable.",
      constrainedBy: parent,
    },
  ]);
  const changes = changesOf(
    ["product.a-project-holds-at-most-one-open-ambiguous-task"],
    ["product.only-an-approved-proposal-finishes-the-work"],
  );
  const classification = classifyDeletions(head, staged, [], [], changes);
  assert.equal(classification.renames[0]?.basis, "parents");

  const diagnostics = deletionDiagnostics(classification, head, staged, [], [], COMMIT_CONFIG);
  const renamed = diagnostics.find((item) => item.code === "PL2109 NODE_RENAMED");
  assert.equal(renamed?.severity, "warning");
  assert.equal(renamed?.action, "ask-user");
  assert.equal(renamed?.infer, false);

  const statementPair = classifyDeletions(
    graphOf([
      {
        id: "product.old",
        level: "product",
        statement: "Each shot has one current version.",
        constrainedBy: parent,
      },
    ]),
    graphOf([
      {
        id: "product.new",
        level: "product",
        statement: "Each shot has one selected version.",
        constrainedBy: parent,
      },
    ]),
    [],
    [],
    changesOf(["product.old"], ["product.new"]),
  );
  const strong = deletionDiagnostics(statementPair, undefined, undefined, [], [], COMMIT_CONFIG);
  assert.equal(strong[0]?.severity, "info");
  assert.equal(strong[0]?.action, "inspect");
});

test("no shared content word, no pair", () => {
  const parent = ["architecture.approval-owner"];
  const head = graphOf([
    {
      id: "mechanism.approval-command",
      level: "mechanism",
      statement: "Approval is implemented by an application command.",
      constrainedBy: parent,
    },
  ]);
  const staged = graphOf([
    {
      id: "mechanism.migrations-runner",
      level: "mechanism",
      statement: "Database migrations run before the server starts.",
      constrainedBy: parent,
    },
  ]);
  const result = classifyDeletions(
    head,
    staged,
    [],
    [],
    changesOf(["mechanism.approval-command"], ["mechanism.migrations-runner"]),
  );
  assert.deepEqual(result.renames, []);
  assert.deepEqual(result.removals, ["mechanism.approval-command"]);
});

test("terms pair on their definitions", () => {
  const headTerms = [
    {
      id: "term.plan",
      level: "product",
      name: "plan",
      definition: "A plan is the set of doable tasks a member approves to resolve one ambiguous task.",
      sourcePath: "docs/product/terms/plan.json",
    },
  ];
  const stagedTerms = [
    {
      id: "term.proposal",
      level: "product",
      name: "proposal",
      definition:
        "A proposal is the set of doable tasks a member approves to resolve one ambiguous task.",
      sourcePath: "docs/product/terms/proposal.json",
    },
  ];
  const result = classifyDeletions(
    undefined,
    undefined,
    headTerms,
    stagedTerms,
    changesOf(["term.plan"], ["term.proposal"]),
  );
  assert.equal(result.renames[0]?.basis, "statement");
  assert.deepEqual(result.removals, []);
});

test("a leaf deletion is reported once and priced at one trailer line", async () => {
  const { root, config } = await createRepository();
  await git(root, "rm", "-q", "docs/mechanism/approval-command.json");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs");

  const staged = await checkStagedCommit(config);
  assert.deepEqual(errors(staged.diagnostics), []);
  assert.deepEqual(staged.deletions.removals, ["mechanism.approval-command"]);
  const removed = staged.diagnostics.find((item) => item.code === "PL2108 NODE_REMOVED");
  assert.equal(removed?.severity, "warning");
  assert.equal(removed?.action, "ask-user");
  assert.match(removed?.question ?? "", /Approval is implemented by an application command\./);
  assert.match(removed?.question ?? "", /Under architecture\.approval-owner, 0 other mechanism node/);

  const message = path.join(root, "message.txt");

  await writeFile(message, "chore: drop the approval mechanism\n\nIt is decided elsewhere now.\n");
  let result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2208 MISSING_REMOVAL_TRAILER"));

  // The camouflage that hid a destroyed law inside a hundred identical lines.
  await writeFile(
    message,
    "chore: drop the approval mechanism\n\nIt is decided elsewhere now.\n\nKnowledge-Change: mechanism.approval-command\n",
  );
  result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2207 REMOVAL_DECLARED_AS_CHANGE"));

  await writeFile(
    message,
    "chore: drop the approval mechanism\n\nIt is decided elsewhere now.\n\nKnowledge-Removed: mechanism.approval-command\n",
  );
  result = await checkCommitMessage(config, message);
  assert.deepEqual(errors(result.diagnostics), []);
  assert.deepEqual([...result.removed], ["mechanism.approval-command"]);
});

test("a rename is one event: one trailer line, no removal warning", async () => {
  const { root, config } = await createRepository();
  await git(root, "rm", "-q", "docs/mechanism/approval-command.json");
  await writeNode(root, {
    id: "mechanism.approval-handler",
    level: "mechanism",
    statement: "Approval is implemented by an application handler.",
    constrainedBy: ["architecture.approval-owner"],
    sync: { constraintsDigest: "pending" },
    implementation: { files: ["src/approve.ts", "test/approve.test.ts"], digest: "pending" },
  });
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs");

  const staged = await checkStagedCommit(config);
  assert.deepEqual(errors(staged.diagnostics), []);
  assert.deepEqual(staged.deletions.removals, []);
  assert.equal(staged.deletions.renames[0]?.basis, "statement");
  assert.ok(!staged.diagnostics.some((item) => item.code === "PL2108 NODE_REMOVED"));
  const renamed = staged.diagnostics.find((item) => item.code === "PL2109 NODE_RENAMED");
  assert.equal(renamed?.severity, "info");
  assert.equal(
    renamed?.details?.suggestedTrailer,
    "Knowledge-Renamed: mechanism.approval-command -> mechanism.approval-handler",
  );

  const message = path.join(root, "message.txt");
  const body = "refactor: approval moves into a handler\n\nThe command grew a second caller.\n\n";

  await writeFile(
    message,
    `${body}Knowledge-Renamed: mechanism.approval-command -> mechanism.approval-handler\n`,
  );
  let result = await checkCommitMessage(config, message);
  assert.deepEqual(errors(result.diagnostics), []);
  assert.deepEqual(result.renamed, [
    { from: "mechanism.approval-command", to: "mechanism.approval-handler" },
  ]);

  // One event, one line: the target owes no separate change trailer.
  await writeFile(
    message,
    `${body}Knowledge-Renamed: mechanism.approval-command -> mechanism.approval-handler\nKnowledge-Change: mechanism.approval-handler\n`,
  );
  result = await checkCommitMessage(config, message);
  assert.ok(
    errors(result.diagnostics).some(
      (item) =>
        item.code === "PL2203 SPURIOUS_KNOWLEDGE_TRAILER" &&
        item.message.includes("Knowledge-Renamed already records it"),
    ),
  );

  await writeFile(
    message,
    `${body}Knowledge-Renamed: mechanism.approval-command -> mechanism.nonexistent\n`,
  );
  result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2210 UNSTAGED_RENAME_TARGET"));

  await writeFile(message, `${body}Knowledge-Renamed: mechanism.approval-command\n`);
  result = await checkCommitMessage(config, message);
  assert.ok(
    errors(result.diagnostics).some(
      (item) =>
        item.code === "PL2210 UNSTAGED_RENAME_TARGET" &&
        item.message.includes("not of the form"),
    ),
  );

  await writeFile(
    message,
    `${body}Knowledge-Removed: mechanism.approval-command\nKnowledge-Renamed: mechanism.approval-command -> mechanism.approval-handler\n`,
  );
  result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2201 DUPLICATE_KNOWLEDGE_TRAILER"));

  await writeFile(
    message,
    `${body}Knowledge-Renamed: mechanism.approval-command -> mechanism.approval-handler\nKnowledge-Removed: behavior.approve-version\n`,
  );
  result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2209 SPURIOUS_REMOVAL_TRAILER"));
});

test("a re-parented child names the parent it abandoned", async () => {
  const { root, config } = await createRepository();
  await writeNode(root, {
    id: "product.version-history",
    level: "product",
    statement: "Past versions of a shot stay listed for review.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  const behaviorPath = path.join(root, "docs", "behavior", "approve-version.json");
  const behavior = JSON.parse(await readFile(behaviorPath, "utf8"));
  behavior.constrainedBy = ["product.version-history"];
  await writeFile(behaviorPath, `${JSON.stringify(behavior, null, 2)}\n`);
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs");

  const staged = await checkStagedCommit(config);
  assert.deepEqual(errors(staged.diagnostics), []);
  const narrowed = staged.diagnostics.find((item) => item.code === "PL2110 COVERAGE_NARROWED");
  assert.equal(narrowed?.severity, "warning");
  assert.equal(narrowed?.nodeId, "product.current-version");
  assert.match(narrowed?.message ?? "", /lost behavior\.approve-version/);
  assert.deepEqual(narrowed?.details?.afterParents, ["product.version-history"]);
});

test("a renamed parent keeps its children through the successor", async () => {
  const { root, config } = await createRepository();
  await git(root, "rm", "-q", "docs/product/current-version.json");
  await writeNode(root, {
    id: "product.selected-version",
    level: "product",
    statement: "Each shot has one selected version.",
    constrainedBy: ["context.review-problem"],
    sync: { constraintsDigest: "pending" },
  });
  const behaviorPath = path.join(root, "docs", "behavior", "approve-version.json");
  const behavior = JSON.parse(await readFile(behaviorPath, "utf8"));
  behavior.constrainedBy = ["product.selected-version"];
  await writeFile(behaviorPath, `${JSON.stringify(behavior, null, 2)}\n`);
  await git(root, "add", "docs");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs");

  const staged = await checkStagedCommit(config);
  assert.deepEqual(errors(staged.diagnostics), []);
  assert.ok(staged.diagnostics.some((item) => item.code === "PL2109 NODE_RENAMED"));
  assert.ok(!staged.diagnostics.some((item) => item.code === "PL2110 COVERAGE_NARROWED"));
  assert.ok(!staged.diagnostics.some((item) => item.code === "PL2108 NODE_REMOVED"));

  const message = path.join(root, "message.txt");
  await writeFile(
    message,
    "refactor: the current version becomes the selected version\n\nReviewers select; the system does not decide currency.\n\n" +
      "Knowledge-Renamed: product.current-version -> product.selected-version\n" +
      "Knowledge-Change: behavior.approve-version\n",
  );
  const result = await checkCommitMessage(config, message);
  assert.deepEqual(errors(result.diagnostics), []);
});

test("a deleted term is a removal like any other", async () => {
  const { root, config } = await createRepository();
  await writeTerm(root, {
    id: "term.plan",
    level: "product",
    name: "plan",
    definition: "A plan is the set of doable tasks a member approves.",
  });
  await git(root, "add", "docs");
  await git(root, "commit", "-qm", "chore: declare the plan term");

  await git(root, "rm", "-q", "docs/product/terms/plan.json");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs");

  const staged = await checkStagedCommit(config);
  assert.deepEqual(errors(staged.diagnostics), []);
  const removed = staged.diagnostics.find((item) => item.code === "PL2108 NODE_REMOVED");
  assert.equal(removed?.nodeId, "term.plan");
  assert.match(removed?.question ?? "", /Withdraw this term\? \*plan\*/);

  const message = path.join(root, "message.txt");
  await writeFile(
    message,
    "chore: retire the plan term\n\nNothing marks it and the word reads as ordinary English.\n\nKnowledge-Removed: term.plan\n",
  );
  const result = await checkCommitMessage(config, message);
  assert.deepEqual(errors(result.diagnostics), []);
});
