import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import type {
  Diagnostic,
  KnowledgeGraph,
  RepositorySnapshot,
  ResolvedConfig,
  SourceCanonicalNode,
  SourceTermNode,
  SyncResult,
} from "./types.js";
import { matchesAny } from "./glob.js";
import { audienceAxis, audienceSetFingerprint, wildcardParents } from "./audience.js";
import { nodeFingerprint, serializeNode } from "./graph.js";
import { digest, sha256 } from "./stable-json.js";
import { createSnapshot } from "./repository.js";
import { prunableDeadPath, validateSnapshot } from "./validation.js";
import { ensureGitRepository, hasUnstagedChanges } from "./git.js";
import {
  buildVocabulary,
  resolveMarks,
  serializeTermNode,
  termFingerprint,
  vocabularyDigest,
} from "./terms.js";

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
  terms: SourceTermNode[] = [],
): Promise<Map<string, SourceCanonicalNode>> {
  const nodes = new Map<string, SourceCanonicalNode>();
  for (const [id, node] of graph.nodes) nodes.set(id, cloneNode(node));
  const vocabulary = buildVocabulary(terms);

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
    // A marked term is an input the way a parent is: the statement's meaning
    // depends on the definition. Absent when nothing is marked, so a graph
    // that uses no vocabulary keeps every node file byte-identical.
    const marked = resolveMarks(node.statement, vocabulary).terms;
    node.sync = {
      constraintsDigest: digest(parentState, "product-lint-constraints-v1"),
      ...(marked.length > 0 ? { vocabularyDigest: vocabularyDigest(marked) } : {}),
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

/**
 * The same derivation for term files. A definition that marks terms depends on
 * their meanings; one that marks nothing carries no sync at all.
 */
export function expectedSynchronizedTerms(
  terms: SourceTermNode[],
): Map<string, SourceTermNode> {
  const vocabulary = buildVocabulary(terms);
  const expected = new Map<string, SourceTermNode>();
  for (const term of terms) {
    const marked = resolveMarks(term.definition, vocabulary).terms.filter(
      (item) => item.id !== term.id,
    );
    const { sync: _sync, ...rest } = term;
    expected.set(term.id, {
      ...rest,
      ...(marked.length > 0 ? { sync: { vocabularyDigest: vocabularyDigest(marked) } } : {}),
    });
  }
  return expected;
}

export async function synchronizationDiagnostics(
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  command = "product-lint knowledge sync --staged",
  previous?: RepositorySnapshot,
  terms: SourceTermNode[] = [],
): Promise<Diagnostic[]> {
  const expected = await expectedSynchronizedNodes(graph, snapshot, previous, terms);
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
    if (node.sync?.vocabularyDigest !== wanted.sync?.vocabularyDigest) {
      diagnostics.push({
        code: "PL2004 STALE_VOCABULARY",
        severity: "error",
        message: `${id} is not synchronized with the definitions of the terms it marks.`,
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
  const expectedTerms = expectedSynchronizedTerms(terms);
  for (const term of terms) {
    const wanted = expectedTerms.get(term.id)!;
    if (term.sync?.vocabularyDigest !== wanted.sync?.vocabularyDigest) {
      diagnostics.push({
        code: "PL2004 STALE_VOCABULARY",
        severity: "error",
        message: `${term.id} is not synchronized with the definitions of the terms it marks.`,
        nodeId: term.id,
        path: term.sourcePath,
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

  const expected = await expectedSynchronizedNodes(
    validation.graph,
    snapshot,
    previous,
    validation.terms,
  );
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

  // Term files hold derived state too, under the same overwrite guard.
  const expectedTerms = expectedSynchronizedTerms(validation.terms);
  for (const term of validation.terms) {
    const wanted = expectedTerms.get(term.id)!;
    if (termFingerprint(term) === termFingerprint(wanted)) {
      unchangedFiles.push(term.sourcePath);
      continue;
    }
    if (await hasUnstagedChanges(config.root, term.sourcePath)) {
      diagnostics.push({
        code: "PL2003 UNSAFE_SYNC_OVERWRITE",
        severity: "error",
        message: `Refusing to overwrite unstaged edits while synchronizing ${term.id}.`,
        nodeId: term.id,
        path: term.sourcePath,
      });
      continue;
    }
    const absolute = path.resolve(config.root, term.sourcePath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, serializeTermNode(wanted), "utf8");
    updatedFiles.push(term.sourcePath);
  }

  return { updatedFiles, unchangedFiles, diagnostics };
}
