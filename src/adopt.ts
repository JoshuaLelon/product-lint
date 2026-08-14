import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  KnowledgeGraph,
  KnowledgeLevel,
  RepositorySnapshot,
  ResolvedConfig,
  SourceCanonicalNode,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import { governedFiles, placeholderStatement } from "./frontier.js";
import { matchesAny, normalizePath } from "./glob.js";
import { serializeNode } from "./graph.js";

/**
 * Give unowned files an owner without inventing a claim.
 *
 * The alternative this replaces is a blocked commit: PL2101 refuses an edit to
 * a file no Mechanism owns, and the repair is a Mechanism, which needs an
 * Architecture parent, which needs a Behavior parent, up to a problem that may
 * not exist. On a repository adopting Product Lint with code already in it that
 * is a wall on the first edit.
 *
 * So the spine is written instead, top to bottom, every node marked `draft`.
 * The logistics are satisfied at once — the file has an owner, every node has a
 * parent — and what is missing is exactly one thing per node: a sentence. That
 * converts a block into a counted debt, and `ship` refuses while any remains.
 *
 * The same walk over the whole tree is the bottom-up bootstrap: cluster, write
 * spines, then revise top-down. One mechanism, two entry points.
 */
export interface AdoptResult {
  /** Directory prefixes adopted, each with the files it covers. */
  clusters: { directory: string; files: string[]; nodes: string[] }[];
  written: string[];
  /** Files already owned, so nothing was written for them. */
  alreadyOwned: string[];
}

function ownedBy(graph: KnowledgeGraph, file: string): boolean {
  return [...graph.nodes.values()].some(
    (node) =>
      node.level === "mechanism" &&
      node.implementation &&
      matchesAny(file, node.implementation.files),
  );
}

export function slugFor(directory: string): string {
  const slug = directory
    .split("/")
    .filter((part) => part && part !== ".")
    .join("-")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "root";
}

/** The static prefix of a governed glob: `src/**` is rooted at `src`. */
export function globRoots(include: string[]): string[] {
  const roots = include
    .map((pattern) =>
      normalizePath(pattern)
        .split("/")
        .filter((part) => !/[*?{]/.test(part))
        .join("/"),
    )
    .filter(Boolean);
  return [...new Set(roots)].sort((left, right) => right.length - left.length);
}

/**
 * One cluster per module: the first directory beneath a governed root.
 *
 * The two obvious alternatives are both wrong. One spine per file gives six
 * placeholder nodes each, so a mid-sized repository gains thousands and the
 * report is less readable than the unowned list it replaced. One spine for the
 * whole tree is a single trunk, and the point of drafting bottom-up is to SEE
 * what problems the code already implies — a graph with one problem in it says
 * nothing to revise. Directory structure is the best deterministic proxy for
 * where a codebase thinks its own boundaries are.
 *
 * A directory holding files a real Mechanism already owns is split finer, so a
 * generated glob never reaches across an existing claim and trips PL0603.
 */
export function clusterDirectories(
  unowned: string[],
  owned: string[],
  includeRoots: string[],
): string[] {
  const moduleFor = (file: string): string => {
    const root = includeRoots.find((entry) => file.startsWith(`${entry}/`));
    if (!root) return path.posix.dirname(file);
    const rest = file.slice(root.length + 1);
    const segments = rest.split("/");
    // A file sitting directly in the root has no module of its own.
    return segments.length <= 1 ? root : `${root}/${segments[0]}`;
  };

  const ownedModules = new Set(owned.map(moduleFor));
  const chosen = new Set<string>();
  for (const file of unowned) {
    const module = moduleFor(file);
    // Contested module: fall back to the file's own directory rather than
    // claiming a glob that would overlap the Mechanism already there.
    chosen.add(ownedModules.has(module) ? path.posix.dirname(file) : module);
  }
  return [...chosen].sort();
}

/**
 * One audience placeholder for the repository, not one per module.
 *
 * Every spine needs a chain to the root or PL1104 refuses its top node, but a
 * codebase does not gain an audience per directory — writing one per cluster
 * would state, in the graph, that `src/billing` serves different people than
 * `src/util`, which is a claim adopt has no basis for. Sharing it also makes
 * the draft a forest hanging off one root, which is the shape a real graph has.
 */
const SHARED_AUDIENCE = "audience.draft";

function spineFor(directory: string): SourceCanonicalNode[] {
  const slug = slugFor(directory);
  const nodes: SourceCanonicalNode[] = [];
  let parent: string | undefined;
  for (const level of KNOWLEDGE_LEVELS) {
    const id = level === "audience" ? SHARED_AUDIENCE : `${level}.draft-${slug}`;
    nodes.push({
      schemaVersion: 1,
      id,
      level: level as KnowledgeLevel,
      statement: placeholderStatement(level),
      constrainedBy: parent ? [parent] : [],
      draft: true,
      sync: { constraintsDigest: "pending" },
      ...(level === "mechanism"
        ? { implementation: { files: [`${directory}/**`], digest: "pending" } }
        : {}),
      // Node files live beside their level, the way every other node does.
      sourcePath: `docs/${level}/${level === "audience" ? "draft" : `draft-${slug}`}.json`,
    });
    parent = id;
  }
  return nodes;
}

export async function adopt(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  targets: string[],
): Promise<AdoptResult> {
  const governed = governedFiles(config, snapshot);
  const selected =
    targets.length === 0
      ? governed
      : governed.filter((file) =>
          targets.some(
            (target) => file === normalizePath(target) || matchesAny(file, [normalizePath(target)]),
          ),
        );

  const alreadyOwned = selected.filter((file) => ownedBy(graph, file)).sort();
  const unowned = selected.filter((file) => !ownedBy(graph, file)).sort();
  const owned = governed.filter((file) => ownedBy(graph, file));

  const result: AdoptResult = { clusters: [], written: [], alreadyOwned };
  if (unowned.length === 0) return result;

  const knowledgeRelative = normalizePath(path.relative(config.root, config.knowledgeRoot));
  const roots = globRoots(config.governedPaths.include);
  const seen = new Set<string>();
  for (const directory of clusterDirectories(unowned, owned, roots)) {
    const covered = unowned.filter((file) => file.startsWith(`${directory}/`)).sort();
    const nodes = spineFor(directory).map((node) => ({
      ...node,
      sourcePath: node.sourcePath.replace(/^docs\//, `${knowledgeRelative}/`),
    }));
    // Never touch a node someone wrote. A spine that overwrote a real statement
    // would be the one way this command could destroy knowledge rather than owe it.
    const collisions = nodes.filter((node) => {
      const existing = graph.nodes.get(node.id);
      return existing && !existing.draft;
    });
    if (collisions.length > 0) continue;

    // The shared audience is written once and then reused, so the second
    // cluster hangs off the first cluster's root rather than a duplicate.
    const fresh = nodes.filter((node) => !graph.nodes.has(node.id) && !seen.has(node.id));
    if (fresh.length === 0) continue;
    for (const node of fresh) seen.add(node.id);

    for (const node of fresh) {
      const file = path.join(config.root, node.sourcePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, serializeNode(node), "utf8");
      result.written.push(node.sourcePath);
    }
    result.clusters.push({
      directory,
      files: covered,
      nodes: fresh.map((node) => node.id),
    });
  }
  return result;
}
