import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkCommitMessage, synchronizeStaged } from "../dist/index.js";
import { createRepository, git } from "./_helpers.mjs";

async function stageProductChange(root, config) {
  const productPath = path.join(root, "docs", "product", "current-version.json");
  const product = JSON.parse(await readFile(productPath, "utf8"));
  product.statement = "Each shot has one current version selected for review.";
  await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
  await git(root, "add", "docs/product/current-version.json");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs");
}

test("commit trailers exactly match semantic node changes", async () => {
  const { root, config } = await createRepository();
  await stageProductChange(root, config);
  const message = path.join(root, "message.txt");
  await writeFile(
    message,
    `feat(review): clarify the current version\n\nThe review model needs one unambiguous selected version.\n\nKnowledge-Change: product.current-version\n`,
  );
  const result = await checkCommitMessage(config, message);
  assert.deepEqual(result.diagnostics, []);
});

test("commit subject is unconstrained by default", async () => {
  const { root, config } = await createRepository();
  await stageProductChange(root, config);
  const message = path.join(root, "message.txt");
  await writeFile(
    message,
    `PROJ-4471 [release/2.1] clarify the current version !!!\n\nThe review model needs one unambiguous selected version.\n\nKnowledge-Change: product.current-version\n`,
  );
  const result = await checkCommitMessage(config, message);
  assert.deepEqual(result.diagnostics, []);
});

test("commit.subjectPattern enforces an opt-in subject convention", async () => {
  const { root, config } = await createRepository();
  await stageProductChange(root, config);
  const message = path.join(root, "message.txt");
  const scoped = { ...config, commit: { ...config.commit, subjectPattern: "^[A-Z]+-[0-9]+ " } };
  const body = `\n\nThe review model needs one unambiguous selected version.\n\nKnowledge-Change: product.current-version\n`;

  await writeFile(message, `clarify the current version${body}`);
  let result = await checkCommitMessage(scoped, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2205 SUBJECT_PATTERN_MISMATCH"));

  await writeFile(message, `PROJ-4471 clarify the current version${body}`);
  result = await checkCommitMessage(scoped, message);
  assert.deepEqual(result.diagnostics, []);
});

test("commit validation rejects missing, spurious, and unexplained trailers", async () => {
  const { root, config } = await createRepository();
  await stageProductChange(root, config);
  const message = path.join(root, "message.txt");

  await writeFile(message, "feat(review): clarify the current version\n");
  let result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2202 MISSING_KNOWLEDGE_TRAILER"));
  assert.ok(result.diagnostics.some((item) => item.code === "PL2204 MISSING_KNOWLEDGE_REASON"));

  await writeFile(
    message,
    `feat(review): clarify the current version\n\nReason.\n\nKnowledge-Change: product.current-version\nKnowledge-Change: behavior.approve-version\n`,
  );
  result = await checkCommitMessage(config, message);
  assert.ok(result.diagnostics.some((item) => item.code === "PL2203 SPURIOUS_KNOWLEDGE_TRAILER"));
});
