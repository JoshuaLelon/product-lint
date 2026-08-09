import test from "node:test";
import assert from "node:assert/strict";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { checkStagedCommit, synchronizeStaged } from "../dist/index.js";
import { createRepository, git } from "./_helpers.mjs";

test("a governed file deletion updates its Mechanism digest", async () => {
  const { root, config } = await createRepository();
  await rm(path.join(root, "test", "approve.test.ts"));
  await git(root, "add", "-u", "test/approve.test.ts");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  assert.deepEqual(sync.updatedFiles, ["docs/mechanism/approval-command.json"]);
  await git(root, "add", "docs/mechanism/approval-command.json");
  const check = await checkStagedCommit(config);
  assert.deepEqual(check.diagnostics, []);
});

test("a file rename can move Mechanism ownership in the same staged change", async () => {
  const { root, config } = await createRepository();
  await rename(path.join(root, "src", "approve.ts"), path.join(root, "src", "approve-command.ts"));
  const mechanismPath = path.join(root, "docs", "mechanism", "approval-command.json");
  const mechanism = JSON.parse(await readFile(mechanismPath, "utf8"));
  mechanism.implementation.files = ["src/approve-command.ts", "test/approve.test.ts"];
  await writeFile(mechanismPath, `${JSON.stringify(mechanism, null, 2)}\n`);
  await git(root, "add", "-A", "src", "docs/mechanism/approval-command.json");
  const sync = await synchronizeStaged(config);
  assert.deepEqual(sync.diagnostics, []);
  await git(root, "add", "docs/mechanism/approval-command.json");
  const check = await checkStagedCommit(config);
  assert.deepEqual(check.diagnostics, []);
  assert.ok(check.nodeChanges.semantic.has("mechanism.approval-command"));
});

test("an added governed file without Mechanism ownership is rejected", async () => {
  const { root, config } = await createRepository();
  await writeFile(path.join(root, "src", "unmapped.ts"), "export const value = 1;\n");
  await git(root, "add", "src/unmapped.ts");
  const check = await checkStagedCommit(config);
  assert.ok(check.diagnostics.some((item) => item.code === "PL2101 UNMAPPED_STAGED_FILE"));
});
