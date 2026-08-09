import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createSnapshot, detectFrontier, validateSnapshot } from "../dist/index.js";
import { createRepository } from "./_helpers.mjs";

const MECHANISM = "docs/mechanism/approval-command.json";

async function claim(root, files) {
  const file = path.join(root, MECHANISM);
  const node = JSON.parse(await readFile(file, "utf8"));
  node.implementation.files = files;
  await writeFile(file, `${JSON.stringify(node, null, 2)}\n`, "utf8");
}

async function validate(config) {
  return validateSnapshot(config, await createSnapshot(config, "working"));
}

function dead(diagnostics) {
  return diagnostics.filter((item) => item.code === "PL0502 DEAD_IMPLEMENTATION_PATH");
}

test("a live entry no longer hides a dead one beside it", async () => {
  const { root, config } = await createRepository();
  await claim(root, ["src/approve.ts", "src/deleted-yesterday.ts"]);
  const diagnostics = dead((await validate(config)).diagnostics);
  assert.equal(diagnostics.length, 1);
  const [diagnostic] = diagnostics;
  assert.equal(diagnostic.severity, "error");
  assert.match(diagnostic.message, /mechanism\.approval-command claims src\/deleted-yesterday\.ts/);
  assert.equal(diagnostic.path, MECHANISM);
  assert.equal(diagnostic.nodeId, "mechanism.approval-command");
  assert.equal(diagnostic.details.deadPath, "src/deleted-yesterday.ts");
});

test("one diagnostic per dead entry, not one per node", async () => {
  const { root, config } = await createRepository();
  await claim(root, ["src/approve.ts", "src/gone.ts", "src/also-gone.ts"]);
  const diagnostics = dead((await validate(config)).diagnostics);
  assert.deepEqual(
    diagnostics.map((item) => item.details.deadPath).sort(),
    ["src/also-gone.ts", "src/gone.ts"],
  );
});

test("a glob that matches files stays silent", async () => {
  const { root, config } = await createRepository();
  await claim(root, ["src/**", "test/**"]);
  assert.deepEqual((await validate(config)).diagnostics, []);
});

test("a glob that matches nothing is dead like any other entry", async () => {
  const { root, config } = await createRepository();
  await claim(root, ["src/**", "src/**/*.rs"]);
  const diagnostics = dead((await validate(config)).diagnostics);
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "error");
  assert.equal(diagnostics[0].details.deadPath, "src/**/*.rs");
});

test("a node whose every entry is dead reports PL0501 alone", async () => {
  const { root, config } = await createRepository();
  await claim(root, ["src/gone.ts", "src/also-gone.ts"]);
  const validation = await validate(config);
  assert.deepEqual(dead(validation.diagnostics), []);
  const frontier = detectFrontier(config, validation.graph, await createSnapshot(config, "working"));
  assert.ok(
    frontier.diagnostics.some((item) => item.code === "PL0501 MISSING_IMPLEMENTATION"),
    "PL0501 owns the node that resolves to nothing",
  );
});

test("a graph whose every entry resolves stays clean", async () => {
  const { config } = await createRepository();
  assert.deepEqual((await validate(config)).diagnostics, []);
});
