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
import { nodeFingerprint, serializeNode } from "./graph.js";
import { digest, sha256 } from "./stable-json.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
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
  node: SourceCanonicalNode,
  snapshot: RepositorySnapshot,
): Promise<string> {
  const patterns = node.implementation?.files ?? [];
  const files = snapshot.files.filter((file) => matchesAny(file, patterns)).sort();
  const entries: { path: string; content: string }[] = [];
  for (const file of files) entries.push({ path: file, content: sha256(await snapshot.readFile(file)) });
  return digest(entries, "product-lint-implementation-v1");
}

export async function expectedSynchronizedNodes(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
): Promise<Map<string, SourceCanonicalNode>> {
  const nodes = new Map<string, SourceCanonicalNode>();
  for (const [id, node] of graph.nodes) nodes.set(id, cloneNode(node));

  for (const id of graph.topologicalOrder) {
    const node = nodes.get(id)!;
    const parentState = [...(graph.parents.get(id) ?? [])]
      .sort()
      .map((parentId) => ({ id: parentId, fingerprint: nodeFingerprint(nodes.get(parentId)!) }));
    node.sync = {
      constraintsDigest: digest(parentState, "product-lint-constraints-v1"),
    };
    if (node.level === "mechanism") {
      const files = node.implementation?.files ?? [];
      node.implementation = {
        files: [...files],
        digest: await implementationDigest(node, snapshot),
      };
    }
  }
  return nodes;
}

export async function synchronizationDiagnostics(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  command = "product-lint knowledge sync --staged",
): Promise<Diagnostic[]> {
  const expected = await expectedSynchronizedNodes(graph, snapshot);
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

export async function synchronizeStaged(config: ResolvedConfig): Promise<SyncResult> {
  await ensureGitRepository(config.root);
  const snapshot = await createSnapshot(config, "staged");
  const validation = await validateSnapshot(config, snapshot);
  if (!validation.graph || validation.diagnostics.some((item) => item.severity === "error")) {
    return { updatedFiles: [], unchangedFiles: [], diagnostics: validation.diagnostics };
  }

  const expected = await expectedSynchronizedNodes(validation.graph, snapshot);
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
