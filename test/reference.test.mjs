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

// --- Storage with no reader ---
//
// Everywhere else, a stored thing nothing can reach is already refused: PL0804
// for a term nothing marks, PL0805 for one no statement at its level marks,
// PL1401 for a scope root naming no node, PL1402 for an ignore naming an unknown
// smell. References were the one node type exempt.

test("a reference no surface can reach is refused, not stored", async () => {
  const { root, config } = await createRepository();
  const { stdout } = await git(root, "rev-parse", "HEAD");
  const commit = stdout.trim();
  await mkdir(path.join(root, "docs", "reference"), { recursive: true });
  const file = path.join(root, "docs", "reference", "note.json");
  const write = async (extra) =>
    writeFile(
      file,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "reference.mistake-note",
        kind: "mistake",
        statement: "Approval was lost on re-upload.",
        ...extra,
      }, null, 2)}\n`,
    );
  const check = async () =>
    (await validateSnapshot(config, await createSnapshot(config, "working"))).diagnostics.filter(
      (item) => item.code === "PL1210 UNREACHABLE_REFERENCE",
    );

  // Both readers match on relatedNodes: knowledge for-file and affected-by
  // intersect it with the node set, and PL0920 filters to references that carry
  // it. Without it the file validates, syncs, commits, and is returned by
  // nothing for the rest of the repository's life.
  await write({ evidence: { commit, files: [] } });
  const unreachable = await check();
  assert.equal(unreachable.length, 1);
  assert.equal(unreachable[0].severity, "error");
  assert.match(unreachable[0].message, /names no relatedNodes/);

  // A mistake is reported only while its node has not changed SINCE the commit
  // that recorded it, so with no commit there is nothing to measure since.
  await write({ relatedNodes: ["architecture.approval-owner"] });
  const undatable = await check();
  assert.equal(undatable.length, 1);
  assert.match(undatable[0].message, /no evidence\.commit/);

  // Both present, and it can reach a reader.
  await write({ relatedNodes: ["architecture.approval-owner"], evidence: { commit, files: [] } });
  assert.deepEqual(await check(), []);
});

test("a reference of another kind needs only a reader, not a commit", async () => {
  const { root, config } = await createRepository();
  await mkdir(path.join(root, "docs", "reference"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "reference", "constraint.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      id: "reference.constraint-vendor-api",
      kind: "constraint",
      statement: "The vendor API rejects more than ten uploads a minute.",
      relatedNodes: ["architecture.approval-owner"],
    }, null, 2)}\n`,
  );
  // evidence.commit is what PL0920 measures staleness against, and only a
  // mistake is measured that way. Demanding it of every kind would be a rule
  // about a report that does not read them.
  const validation = await validateSnapshot(config, await createSnapshot(config, "working"));
  assert.deepEqual(
    validation.diagnostics.filter((item) => item.code === "PL1210 UNREACHABLE_REFERENCE"),
    [],
  );
});
