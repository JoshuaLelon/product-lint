import test from "node:test";
import assert from "node:assert/strict";
import { renderTree } from "../dist/tree.js";

test("a short list keeps the file names", () => {
  const tree = renderTree(["src/a.ts", "src/b.ts", "scripts/run.mjs"]);
  assert.match(tree, /a\.ts/);
  assert.match(tree, /b\.ts/);
  assert.match(tree, /run\.mjs/);
  assert.doesNotMatch(tree, /by directory/, "a short list does not need summarizing");
});

test("a long list switches to directory counts and says why", () => {
  const paths = Array.from({ length: 50 }, (_, index) => `src/lib/f${index}.ts`);
  const tree = renderTree(paths);
  assert.match(tree, /by directory, because the list is long/);
  assert.match(tree, /src\/lib\/\s+50 files/);
  assert.doesNotMatch(tree, /f0\.ts/, "names are what the summary trades away");
});

test("a directory with files of its own reports both counts", () => {
  const paths = [
    ...Array.from({ length: 30 }, (_, index) => `src/deep/f${index}.ts`),
    ...Array.from({ length: 5 }, (_, index) => `src/top${index}.ts`),
  ];
  const tree = renderTree(paths);
  assert.match(tree, /src\/\s+35 files, 5 here/, "the subtree total and the directory's own count differ");
  assert.match(tree, /deep\/\s+30 files/);
});

test("a single-child directory chain collapses to one row", () => {
  const tree = renderTree(["src/store/slices/day.ts", "src/store/slices/chat.ts"]);
  assert.match(tree, /src\/store\/slices\//);
  assert.doesNotMatch(tree, /^\s*store\/$/m, "the intermediate rows carry no information");
});

test("every limit is announced, never silent", () => {
  const paths = Array.from({ length: 25 }, (_, index) => `src/f${index}.ts`);
  const tree = renderTree(paths, { summarizeAbove: 100, filesPerDirectory: 8 });
  assert.match(tree, /\.\.\. and 17 more files in this directory/);
});

test("the line cap is announced too", () => {
  // 60 directories of one file each renders as `src/`, then a row per directory
  // and a row per file: 121 lines, of which 10 survive the cap.
  const paths = Array.from({ length: 60 }, (_, index) => `src/d${index}/f.ts`);
  const tree = renderTree(paths, { summarizeAbove: 1000, maxLines: 10 });
  const lines = tree.split("\n");
  assert.equal(lines.length, 11, "ten rows plus the note");
  assert.match(lines.at(-1), /\.\.\. and 111 more line\(s\) not shown/);
});

test("one file reads as one file", () => {
  const paths = Array.from({ length: 40 }, (_, index) => `src/d${index}/only.ts`);
  const tree = renderTree(paths, { maxLines: 100 });
  assert.match(tree, /1 file$/m);
  assert.doesNotMatch(tree, /1 files/);
});

test("an empty list renders nothing", () => {
  assert.equal(renderTree([]), "");
});

test("duplicate paths are counted once", () => {
  const tree = renderTree(["src/a.ts", "src/a.ts", "src/b.ts"]);
  assert.equal(tree.split("\n").filter((line) => line.includes("a.ts")).length, 1);
});
