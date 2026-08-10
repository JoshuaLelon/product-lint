// Adopting Product Lint into a repository that already has code.
//
// Every test here failed before the fix they guard. The whole set came out of
// one real install into a repository of 341 governed files, where init reported
// success and wired nothing, and the first commit produced N instructions that
// the validator would have rejected.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkStagedCommit, loadConfig, initProject, inspectWorkingTree } from "../dist/index.js";
import { annotateDiagnostics, formatDiagnostics } from "../dist/index.js";
import { createRepository, git } from "./_helpers.mjs";

/** A repository with code and no knowledge at all — the adoption case. */
async function createBrownfieldRepository(fileCount = 5) {
  const root = await mkdtemp(path.join(tmpdir(), "product-lint-brownfield-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Product Lint Test");
  await writeFile(
    path.join(root, "product-lint.config.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        root: ".",
        knowledgeRoot: "docs",
        governedPaths: {
          include: ["src/**"],
          exclude: ["docs/**", "node_modules/**"],
        },
        commit: { trailer: "Knowledge-Change", requireBody: true },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  for (let i = 0; i < fileCount; i += 1) {
    await writeFile(path.join(root, "src", `f${i}.ts`), `export const f${i} = ${i};\n`);
  }
  for (const level of ["context", "product", "behavior", "architecture", "mechanism"]) {
    await mkdir(path.join(root, "docs", level), { recursive: true });
    await writeFile(path.join(root, "docs", level, ".gitkeep"), "");
  }
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "seed code without knowledge");
  return { root, config: await loadConfig(root) };
}

test("an empty graph reports the frontier once, not one wrong instruction per file", async () => {
  const { root, config } = await createBrownfieldRepository(5);
  for (let i = 0; i < 5; i += 1) {
    await writeFile(path.join(root, "src", `f${i}.ts`), `export const f${i} = ${i + 100};\n`);
  }
  await git(root, "add", "src");

  const result = await checkStagedCommit(config);
  const codes = result.diagnostics.map((item) => item.code);

  assert.equal(
    codes.filter((code) => code.startsWith("PL2101")).length,
    0,
    "PL2101 tells the agent to create a Mechanism node, which PL1104 then rejects when no Architecture level exists",
  );
  const ungoverned = result.diagnostics.filter((item) =>
    item.code.startsWith("PL2106"),
  );
  assert.equal(ungoverned.length, 1, "one diagnostic, whatever the file count");
  assert.equal(ungoverned[0].requiredLevel, "audience");
  assert.equal(ungoverned[0].action, "ask-user");
  assert.equal(ungoverned[0].infer, false);
  assert.deepEqual(ungoverned[0].details.files, [
    "src/f0.ts",
    "src/f1.ts",
    "src/f2.ts",
    "src/f3.ts",
    "src/f4.ts",
  ]);
});

test("the ungoverned diagnostic names the shallowest absent level, not always context", async () => {
  const { root, config } = await createBrownfieldRepository(1);
  await mkdir(path.join(root, "docs", "audience"), { recursive: true });
  await writeFile(
    path.join(root, "docs", "audience", "role-solo.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "audience.role.solo",
        level: "audience",
        statement: "The product serves a person working alone.",
        constrainedBy: [],
        sync: { constraintsDigest: "pending" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    path.join(root, "docs", "context", "problem.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        id: "context.problem",
        level: "context",
        statement: "One person loses track of their own work.",
        constrainedBy: ["audience.role.solo"],
        sync: { constraintsDigest: "pending" },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(path.join(root, "src", "f0.ts"), "export const f0 = 99;\n");
  await git(root, "add", ".");

  const result = await checkStagedCommit(config);
  const ungoverned = result.diagnostics.find((item) => item.code.startsWith("PL2106"));
  assert.ok(ungoverned, "still ungoverned with only a Context node");
  assert.equal(ungoverned.requiredLevel, "product", "context exists, so product is next");
});

test("the ungoverned diagnostic carries a repair and the ask formats", async () => {
  const { root, config } = await createBrownfieldRepository(1);
  await writeFile(path.join(root, "src", "f0.ts"), "export const f0 = 7;\n");
  await git(root, "add", "src");

  const result = await checkStagedCommit(config);
  const [ungoverned] = annotateDiagnostics(
    result.diagnostics.filter((item) => item.code.startsWith("PL2106")),
  );
  assert.match(ungoverned.fix, /Do not create a Mechanism node yet/);
  assert.match(ungoverned.fix, /governedPaths\.include/, "brownfield repos need the narrowing advice");
  assert.ok(ungoverned.ask, "it asks a frontier question, so it needs the ask formats");
  assert.ok(ungoverned.style, "it asks for a written statement");
});

test("a graph that reaches Architecture still gets the per-file PL2101", async () => {
  // The regression guard for the fix above: once a Mechanism node CAN exist,
  // "create a Mechanism node for this file" is correct advice again.
  const { root, config } = await createRepository();
  await writeFile(path.join(root, "src", "reject.ts"), "export const reject = () => false;\n");
  await git(root, "add", "src/reject.ts");

  const result = await checkStagedCommit(config);
  const unmapped = result.diagnostics.filter((item) => item.code.startsWith("PL2101"));
  assert.equal(unmapped.length, 1);
  assert.equal(unmapped[0].path, "src/reject.ts");
  assert.equal(
    result.diagnostics.filter((item) => item.code.startsWith("PL2106")).length,
    0,
    "the graph can own a Mechanism node, so the frontier is not the answer",
  );
});

test("the frontier names the ungoverned files even with no Context node", async () => {
  // `ship` and `frontier` used to return MISSING_CONTEXT alone here, because the
  // missing-context branch returned before it ever looked at the files. A
  // repository with hundreds of unowned files was told only that it had no
  // Context, and never how big the job was.
  const { config } = await createBrownfieldRepository(4);
  const status = await inspectWorkingTree(config);
  const codes = status.frontier.diagnostics.map((item) => item.code);

  assert.ok(codes.some((code) => code.startsWith("PL0011")), "Audience is still the next question");
  const ungoverned = status.frontier.diagnostics.filter((item) => item.code.startsWith("PL0602"));
  assert.equal(ungoverned.length, 1);
  assert.equal(ungoverned[0].details.files.length, 4);
  assert.equal(
    codes.filter((code) => code.startsWith("PL0601")).length,
    0,
    "one cause and one repair, so one diagnostic, not one per file",
  );
});

test("the ungoverned files are rendered as a tree in human output", async () => {
  const { config } = await createBrownfieldRepository(3);
  const status = await inspectWorkingTree(config);
  const text = formatDiagnostics(
    status.frontier.diagnostics.filter((item) => item.code.startsWith("PL0602")),
  );
  assert.match(text, /files \(3\):/);
  assert.match(text, /src\//);
  assert.match(text, /f0\.ts/);
});

test("a graph that reaches Architecture goes back to one diagnostic per file", async () => {
  const { root, config } = await createRepository();
  await writeFile(path.join(root, "src", "orphan.ts"), "export const orphan = 1;\n");

  const status = await inspectWorkingTree(config);
  const perFile = status.frontier.diagnostics.filter((item) => item.code.startsWith("PL0601"));
  assert.equal(perFile.length, 1);
  assert.equal(perFile[0].path, "src/orphan.ts");
  assert.equal(
    status.frontier.diagnostics.filter((item) => item.code.startsWith("PL0602")).length,
    0,
  );
});

test("init says so when it leaves an existing hook unwired", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "product-lint-init-"));
  await git(root, "init", "-q");
  await writeFile(
    path.join(root, "lefthook.yml"),
    "pre-commit:\n  jobs:\n    - name: existing\n      run: echo hi\n",
  );

  const result = await initProject(root);
  const notes = result.notes.join("\n");

  assert.match(notes, /NOT INSTALLED/, "a half-install must not read as a success");
  assert.match(notes, /knowledge sync --staged/, "it must name the pre-commit command it skipped");
  assert.match(notes, /commit check --staged/);

  const lefthook = await readFile(path.join(root, "lefthook.yml"), "utf8");
  assert.match(lefthook, /^commit-msg:/m, "the hook it CAN add is still added");
  assert.equal(
    lefthook.match(/^pre-commit:/gm).length,
    1,
    "it must not append a second pre-commit key and shadow the project's own jobs",
  );
});

test("init reports a missing hook script rather than claiming success", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "product-lint-hookpath-"));
  await git(root, "init", "-q");
  await mkdir(path.join(root, ".githooks"), { recursive: true });
  await git(root, "config", "core.hooksPath", ".githooks");

  const result = await initProject(root);
  const notes = result.notes.join("\n");

  assert.match(
    notes,
    /cannot run|NOT installed/i,
    "a lefthook.yml block with no hook script is a dead hook and init must say so",
  );
  assert.match(notes, /lefthook install --force/, "it must name the command that fixes it");
});
