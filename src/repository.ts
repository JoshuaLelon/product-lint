import path from "node:path";
import { readdir, readFile } from "node:fs/promises";
import type { RepositorySnapshot, ResolvedConfig, SnapshotKind } from "./types.js";
import { normalizePath } from "./glob.js";
import {
  listFilesAtRef,
  listHeadFiles,
  listIndexFiles,
  readFileAtRef,
  readHeadFile,
  readIndexFile,
} from "./git.js";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".product-lint"]);

async function walk(directory: string, root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  const output: string[] = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) output.push(...(await walk(absolute, root)));
    }
    else if (entry.isFile()) output.push(normalizePath(path.relative(root, absolute)));
  }
  return output;
}

/**
 * The repository as it stood at some other ref, so the graph there can be built
 * and compared. `head` is this with the ref fixed; the kinds stay a closed set
 * because every other command means one of exactly three things.
 */
export async function createRefSnapshot(
  config: ResolvedConfig,
  ref: string,
): Promise<RepositorySnapshot> {
  const files = await listFilesAtRef(config.root, ref);
  const set = new Set(files);
  return {
    kind: "head",
    files,
    readFile: async (file) => readFileAtRef(config.root, ref, normalizePath(file)),
    hasFile: (file) => set.has(normalizePath(file)),
  };
}

export async function createSnapshot(
  config: ResolvedConfig,
  kind: SnapshotKind,
): Promise<RepositorySnapshot> {
  if (kind === "working") {
    const files = (await walk(config.root, config.root)).sort();
    const set = new Set(files);
    return {
      kind,
      files,
      readFile: async (file) => readFile(path.resolve(config.root, file), "utf8"),
      hasFile: (file) => set.has(normalizePath(file)),
    };
  }

  const files = kind === "staged" ? await listIndexFiles(config.root) : await listHeadFiles(config.root);
  const set = new Set(files);
  return {
    kind,
    files,
    readFile: async (file) =>
      kind === "staged"
        ? readIndexFile(config.root, normalizePath(file))
        : readHeadFile(config.root, normalizePath(file)),
    hasFile: (file) => set.has(normalizePath(file)),
  };
}
