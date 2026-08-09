import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSnapshot, validateSnapshot } from "../dist/index.js";
import { createRepository, git } from "./_helpers.mjs";

test("reference evidence resolves against an immutable commit", async () => {
  const { root, config } = await createRepository();
  const { stdout } = await git(root, "rev-parse", "HEAD");
  const commit = stdout.trim();
  await mkdir(path.join(root, "docs", "reference"), { recursive: true });
  const referencePath = path.join(root, "docs", "reference", "route-transactions.json");
  await writeFile(
    referencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      id: "reference.mistake-route-transactions",
      kind: "mistake",
      statement: "Route-owned transactions previously split an atomic operation.",
      relatedNodes: ["architecture.approval-owner"],
      evidence: {
        commit,
        files: [{ path: "src/approve.ts", lines: [1, 1] }],
      },
    }, null, 2)}\n`,
  );
  let validation = await validateSnapshot(config, await createSnapshot(config, "working"));
  assert.deepEqual(validation.diagnostics, []);

  await writeFile(
    referencePath,
    `${JSON.stringify({
      schemaVersion: 1,
      id: "reference.mistake-route-transactions",
      kind: "mistake",
      statement: "Broken evidence path.",
      evidence: { commit, files: [{ path: "src/missing.ts" }] },
    }, null, 2)}\n`,
  );
  validation = await validateSnapshot(config, await createSnapshot(config, "working"));
  assert.ok(validation.diagnostics.some((item) => item.code === "PL1209 MISSING_REFERENCE_PATH"));
});
