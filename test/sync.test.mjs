import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkStagedCommit, synchronizeStaged } from "../dist/index.js";
import { createRepository, git } from "./_helpers.mjs";

test("implementation changes update the governing Mechanism node", async () => {
  const { root, config } = await createRepository();
  const mechanismPath = path.join(root, "docs", "mechanism", "approval-command.json");
  const before = JSON.parse(await readFile(mechanismPath, "utf8"));

  await writeFile(path.join(root, "src", "approve.ts"), "export const approve = () => 'ok';\n");
  await git(root, "add", "src/approve.ts");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  assert.deepEqual(sync.updatedFiles, ["docs/mechanism/approval-command.json"]);

  const after = JSON.parse(await readFile(mechanismPath, "utf8"));
  assert.notEqual(after.implementation.digest, before.implementation.digest);
  await git(root, "add", "docs/mechanism/approval-command.json");
  const check = await checkStagedCommit(config);
  assert.deepEqual(check.diagnostics, []);
});

test("semantic upstream changes propagate synchronization to all descendants", async () => {
  const { root, config } = await createRepository();
  const productPath = path.join(root, "docs", "product", "current-version.json");
  const product = JSON.parse(await readFile(productPath, "utf8"));
  product.statement = "Each shot has exactly one current reviewable version.";
  await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
  await git(root, "add", "docs/product/current-version.json");

  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  assert.deepEqual(sync.updatedFiles, [
    "docs/behavior/approve-version.json",
    "docs/architecture/approval-owner.json",
    "docs/mechanism/approval-command.json",
  ]);
  await git(root, "add", "docs");
  const check = await checkStagedCommit(config);
  assert.deepEqual(check.diagnostics, []);
  assert.deepEqual([...check.nodeChanges.semantic], ["product.current-version"]);
  assert.deepEqual(new Set(check.nodeChanges.synchronizationOnly), new Set([
    "behavior.approve-version",
    "architecture.approval-owner",
    "mechanism.approval-command",
  ]));
});

async function stageClaim(root, files) {
  const mechanismPath = path.join(root, "docs", "mechanism", "approval-command.json");
  const node = JSON.parse(await readFile(mechanismPath, "utf8"));
  node.implementation.files = files;
  await writeFile(mechanismPath, `${JSON.stringify(node, null, 2)}\n`);
  await git(root, "add", "docs/mechanism/approval-command.json");
  return mechanismPath;
}

test("synchronization refuses a dead path it cannot prove was deleted", async () => {
  const { root, config } = await createRepository();
  const mechanismPath = await stageClaim(root, [
    "src/approve.ts",
    "test/approve.test.ts",
    "src/typo.ts",
  ]);

  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.updatedFiles, []);
  assert.ok(sync.diagnostics.some((item) => item.code === "PL0502 DEAD_IMPLEMENTATION_PATH"));

  // src/typo.ts was never in HEAD, so nothing proves it was deleted. Pruning it
  // would silently narrow the claim instead of reporting it.
  const after = JSON.parse(await readFile(mechanismPath, "utf8"));
  assert.ok(after.implementation.files.includes("src/typo.ts"));
});

test("synchronization never prunes a glob, however dead", async () => {
  const { root, config } = await createRepository();
  const mechanismPath = await stageClaim(root, ["src/**", "test/**", "src/**/*.rs"]);

  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.updatedFiles, []);
  assert.ok(sync.diagnostics.some((item) => item.code === "PL0502 DEAD_IMPLEMENTATION_PATH"));

  const after = JSON.parse(await readFile(mechanismPath, "utf8"));
  assert.ok(after.implementation.files.includes("src/**/*.rs"));
});

test("staged semantic changes fail before descendant synchronization", async () => {
  const { root, config } = await createRepository();
  const productPath = path.join(root, "docs", "product", "current-version.json");
  const product = JSON.parse(await readFile(productPath, "utf8"));
  product.statement = "Changed without propagation.";
  await writeFile(productPath, `${JSON.stringify(product, null, 2)}\n`);
  await git(root, "add", "docs/product/current-version.json");

  const check = await checkStagedCommit(config);
  const codes = new Set(check.diagnostics.map((item) => item.code));
  assert.ok(codes.has("PL2103 STALE_DEPENDENT"));
  assert.ok(codes.has("PL2001 STALE_CONSTRAINTS"));
});
