import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  Diagnostic,
  KnowledgeGraph,
  RepositorySnapshot,
  ResolvedConfig,
  SourceCanonicalNode,
  SyncResult,
} from "./types.js";
import { matchesAny } from "./glob.js";
import { audienceAxis, audienceSetFingerprint, wildcardParents } from "./audience.js";
import { nodeFingerprint, serializeNode } from "./graph.js";
import { digest, sha256 } from "./stable-json.js";
import { createSnapshot } from "./repository.js";
import { prunableDeadPath, validateSnapshot } from "./validation.js";
import { ensureGitRepository, hasUnstagedChanges } from "./git.js";

function cloneNode(node: SourceCanonicalNode): SourceCanonicalNode {
  return {
    ...node,
    constrainedBy: [...node.constrainedBy],
    ...(node.sync ? { sync: { ...node.sync } } : {}),
    ...(node.implementation
      ? { implementation: { files: [...node.implementation.files], digest: node.implementation.digest } }
      : {}),
  };
}

async function implementationDigest(
  patterns: string[],
  snapshot: RepositorySnapshot,
): Promise<string> {
  const files = snapshot.files.filter((file) => matchesAny(file, patterns)).sort();
  const entries: { path: string; content: string }[] = [];
  for (const file of files) entries.push({ path: file, content: sha256(await snapshot.readFile(file)) });
  return digest(entries, "product-lint-implementation-v1");
}

/**
 * Pass `previous` to let synchronization prune implementation entries the
 * change proves were deleted. Without it no entry is ever removed, so a caller
 * with no earlier snapshot to compare against keeps the authored list intact.
 */
export async function expectedSynchronizedNodes(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  previous?: RepositorySnapshot,
): Promise<Map<string, SourceCanonicalNode>> {
  const nodes = new Map<string, SourceCanonicalNode>();
  for (const [id, node] of graph.nodes) nodes.set(id, cloneNode(node));

  for (const id of graph.topologicalOrder) {
    const node = nodes.get(id)!;
    // A wildcard parent contributes the SET's membership, not a node's content.
    // Without this a scope written as "every value of this set" would not move
    // when the set gained a value, and the node would keep a digest that says
    // it is current while its meaning has quietly changed underneath it.
    const parentState = [
      ...[...(graph.parents.get(id) ?? [])].map((parentId) => ({
        id: parentId,
        fingerprint: nodeFingerprint(nodes.get(parentId)!),
      })),
      ...wildcardParents(node).map((wildcard) => ({
        id: wildcard,
        fingerprint: audienceSetFingerprint(graph, audienceAxis(wildcard)!),
      })),
    ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    node.sync = {
      constraintsDigest: digest(parentState, "product-lint-constraints-v1"),
    };
    if (node.level === "mechanism") {
      const files = (node.implementation?.files ?? []).filter(
        (entry) => !previous || !prunableDeadPath(entry, snapshot, previous),
      );
      node.implementation = {
        files,
        digest: await implementationDigest(files, snapshot),
      };
    }
  }
  return nodes;
}

export async function synchronizationDiagnostics(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  command = "product-lint knowledge sync --staged",
  previous?: RepositorySnapshot,
): Promise<Diagnostic[]> {
  const expected = await expectedSynchronizedNodes(graph, snapshot, previous);
  const diagnostics: Diagnostic[] = [];
  for (const [id, node] of graph.nodes) {
    const wanted = expected.get(id)!;
    if (node.sync?.constraintsDigest !== wanted.sync?.constraintsDigest) {
      diagnostics.push({
        code: "PL2001 STALE_CONSTRAINTS",
        severity: "error",
        message: `${id} is not synchronized with its direct constraints.`,
        nodeId: id,
        path: node.sourcePath,
        action: "run-command",
        command,
      });
    }
    if (
      node.level === "mechanism" &&
      node.implementation?.digest !== wanted.implementation?.digest
    ) {
      diagnostics.push({
        code: "PL2002 STALE_IMPLEMENTATION",
        severity: "error",
        message: `${id} is not synchronized with its governed implementation files.`,
        nodeId: id,
        path: node.sourcePath,
        action: "run-command",
        command,
      });
    }
  }
  return diagnostics;
}

/** True when this run will repair the diagnostic, so it must not also stop it. */
function repairedByThisSync(
  diagnostic: Diagnostic,
  snapshot: RepositorySnapshot,
  previous: RepositorySnapshot,
): boolean {
  if (diagnostic.code !== "PL0502 DEAD_IMPLEMENTATION_PATH") return false;
  const entry = diagnostic.details?.deadPath;
  return typeof entry === "string" && prunableDeadPath(entry, snapshot, previous);
}

export async function synchronizeStaged(config: ResolvedConfig): Promise<SyncResult> {
  await ensureGitRepository(config.root);
  const snapshot = await createSnapshot(config, "staged");
  const previous = await createSnapshot(config, "head");
  const validation = await validateSnapshot(config, snapshot);
  // Synchronization exists to repair derived state, so an error it is about to
  // repair must not stop it first. Every other error is a claim synchronization
  // cannot verify, and those still stop here.
  const blocking = validation.diagnostics.filter(
    (item) => item.severity === "error" && !repairedByThisSync(item, snapshot, previous),
  );
  if (!validation.graph || blocking.length > 0) {
    return { updatedFiles: [], unchangedFiles: [], diagnostics: validation.diagnostics };
  }

  const expected = await expectedSynchronizedNodes(validation.graph, snapshot, previous);
  const updatedFiles: string[] = [];
  const unchangedFiles: string[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const id of validation.graph.topologicalOrder) {
    const current = validation.graph.nodes.get(id)!;
    const wanted = expected.get(id)!;
    if (nodeFingerprint(current) === nodeFingerprint(wanted)) {
      unchangedFiles.push(current.sourcePath);
      continue;
    }
    if (await hasUnstagedChanges(config.root, current.sourcePath)) {
      diagnostics.push({
        code: "PL2003 UNSAFE_SYNC_OVERWRITE",
        severity: "error",
        message: `Refusing to overwrite unstaged edits while synchronizing ${id}.`,
        nodeId: id,
        path: current.sourcePath,
      });
      continue;
    }
    const absolute = path.resolve(config.root, current.sourcePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, serializeNode(wanted), "utf8");
    updatedFiles.push(current.sourcePath);
  }

  return { updatedFiles, unchangedFiles, diagnostics };
}
