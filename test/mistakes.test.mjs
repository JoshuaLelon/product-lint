// The one place this tool records that a claim was WRONG, made to resurface.
//
// Everything else it checks is missing, stale, or badly shaped — facts about the
// graph's form. Nothing says a statement is false, and nothing can, because that
// is a judgement. A `mistake` reference is how a person records it afterwards,
// and until now that record was read by two query commands and nothing else.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { inspectWorkingTree, loadConfig } from "../dist/index.js";
import { createRepository, git, readNode, writeNode } from "./_helpers.mjs";

async function writeMistake(root, { id, nodes, commit, statement }) {
  const file = path.join(root, "docs", "reference", `${id}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: `reference.${id}`,
        kind: "mistake",
        statement,
        relatedNodes: nodes,
        evidence: { commit, files: [] },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

async function headCommit(root) {
  return (await git(root, "rev-parse", "HEAD")).stdout.trim();
}

test("a mistake stands while the claim it names has not changed since", async () => {
  const { root } = await createRepository();
  await writeMistake(root, {
    id: "mistake-one-version",
    nodes: ["product.current-version"],
    commit: await headCommit(root),
    statement: "We modelled one current version and reviewers kept approving stale renders.",
  });

  const status = await inspectWorkingTree(await loadConfig(root));
  const standing = status.mistakes.find((item) => item.code === "PL0920 STANDING_MISTAKE");
  assert.ok(standing, "the most expensive knowledge in the repository must resurface");
  assert.equal(standing.nodeId, "product.current-version");
  assert.equal(standing.severity, "info", "recorded knowledge is not a fault");
  assert.match(standing.message, /reviewers kept approving stale renders/);
  // Usually-fine, like every other judgement finding: the mistake may have been
  // about the implementation rather than the claim.
  assert.match(standing.details.whenFine, /implementation rather than the claim/);
});

test("revising the claim answers the mistake, so it stops being reported", async () => {
  const { root } = await createRepository();
  const commit = await headCommit(root);
  await writeMistake(root, {
    id: "mistake-one-version",
    nodes: ["product.current-version"],
    commit,
    statement: "We modelled one current version and reviewers kept approving stale renders.",
  });
  const node = await readNode(root, "product", "current-version");
  await writeNode(root, { ...node, statement: "Each shot has one version a reviewer may approve." });

  const status = await inspectWorkingTree(await loadConfig(root));
  // Repeating a mistake someone already answered would train a reader to skip
  // the one report carrying hard-won knowledge.
  assert.deepEqual(status.mistakes, []);
});

test("a mistake naming no node, or a node that is still a draft, reports nothing", async () => {
  const { root } = await createRepository();
  const commit = await headCommit(root);
  await writeMistake(root, {
    id: "mistake-unattached",
    nodes: [],
    commit,
    statement: "Something went wrong and nobody said what it was about.",
  });
  const node = await readNode(root, "product", "current-version");
  await writeNode(root, { ...node, draft: true });
  await writeMistake(root, {
    id: "mistake-on-draft",
    nodes: ["product.current-version"],
    commit,
    statement: "A placeholder cannot be the wrong claim yet.",
  });

  const status = await inspectWorkingTree(await loadConfig(root));
  assert.deepEqual(status.mistakes, []);
});
