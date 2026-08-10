// A governed file has one Mechanism owner.
//
// Between two prose statements, mutual exclusivity has no deterministic test.
// Between two Mechanism nodes it has one, because a Mechanism binds to files and
// the snapshot is the evidence. These cases are the shapes that evidence takes.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { loadConfig, validateSnapshot, createSnapshot } from "../dist/index.js";
import { createRepository, writeNode } from "./_helpers.mjs";

async function validateWith(root, mechanisms, extraFiles = []) {
  for (const file of extraFiles) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), "// file\n");
  }
  for (const node of mechanisms) await writeNode(root, node);
  const config = await loadConfig(root);
  const snapshot = await createSnapshot(config, "working");
  return validateSnapshot(config, snapshot);
}

function overlaps(result) {
  return result.diagnostics.filter((item) => item.code === "PL0603 OVERLAPPING_MECHANISM");
}

const base = {
  level: "mechanism",
  constrainedBy: ["architecture.approval-owner"],
  sync: { constraintsDigest: "pending" },
};

test("two mechanisms claiming the same file is an error", async () => {
  const { root } = await createRepository();
  const result = await validateWith(root, [
    {
      ...base,
      id: "mechanism.reader",
      statement: "The reader loads approval records.",
      implementation: { files: ["src/shared.ts", "src/reader.ts"], digest: "pending" },
    },
    {
      ...base,
      id: "mechanism.writer",
      statement: "The writer stores approval records.",
      implementation: { files: ["src/shared.ts", "src/writer.ts"], digest: "pending" },
    },
  ], ["src/shared.ts", "src/reader.ts", "src/writer.ts"]);

  const found = overlaps(result);
  assert.equal(found.length, 1);
  assert.equal(found[0].severity, "error");
  assert.deepEqual(found[0].details.mechanisms, ["mechanism.reader", "mechanism.writer"]);
  assert.deepEqual(found[0].details.files, ["src/shared.ts"]);
  // Partial intersection is not containment, and must not claim to be.
  assert.equal(found[0].details.containment, undefined);
});

test("containment is named, because the repair is a merge not a re-partition", async () => {
  const { root } = await createRepository();
  const result = await validateWith(root, [
    {
      ...base,
      id: "mechanism.loading",
      statement: "Audit files are read from disk.",
      implementation: { files: ["src/load.ts"], digest: "pending" },
    },
    {
      ...base,
      id: "mechanism.declarative",
      statement: "The audit catalog is assembled at run time.",
      implementation: { files: ["src/load.ts", "src/catalog.ts"], digest: "pending" },
    },
  ], ["src/load.ts", "src/catalog.ts"]);

  const found = overlaps(result);
  assert.equal(found.length, 1);
  assert.deepEqual(found[0].details.containment, {
    inner: "mechanism.loading",
    outer: "mechanism.declarative",
  });
  assert.match(found[0].message, /claims every file/);
});

test("globs that resolve to disjoint files do not overlap", async () => {
  const { root } = await createRepository();
  const result = await validateWith(root, [
    {
      ...base,
      id: "mechanism.slices",
      statement: "Slice modules hold one action prefix each.",
      implementation: { files: ["src/store/slices/**"], digest: "pending" },
    },
    {
      ...base,
      id: "mechanism.entry",
      statement: "The reducer entry point routes actions.",
      implementation: { files: ["src/store/reducer.ts"], digest: "pending" },
    },
  ], ["src/store/slices/day.ts", "src/store/reducer.ts"]);

  assert.deepEqual(overlaps(result), []);
});

test("overlap is judged on files, so two globs that can both match still pass when nothing does", async () => {
  const { root } = await createRepository();
  const result = await validateWith(root, [
    {
      ...base,
      id: "mechanism.wide",
      statement: "The wide node owns the generated tree.",
      implementation: { files: ["src/gen/**/*.ts"], digest: "pending" },
    },
    {
      ...base,
      id: "mechanism.narrow",
      statement: "The narrow node owns generated output.",
      implementation: { files: ["src/gen/**/*.gen.ts"], digest: "pending" },
    },
  ], ["src/gen/plain.ts"]);

  // The patterns could both match src/gen/a.gen.ts. No such file exists, so
  // there is no evidence and therefore no diagnostic — the standard PL0502 keeps.
  assert.deepEqual(overlaps(result), []);
});

test("an empty snapshot is no evidence either way", async () => {
  const { root } = await createRepository();
  const config = await loadConfig(root);
  const snapshot = await createSnapshot(config, "working");
  const empty = { ...snapshot, files: [], hasFile: () => false };
  const result = await validateSnapshot(config, empty);
  assert.deepEqual(overlaps(result), []);
});
