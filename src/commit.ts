import path from "node:path";
import { readFile } from "node:fs/promises";
import type {
  CommitCheckResult,
  CommitMessageResult,
  Diagnostic,
  GitChange,
  KnowledgeGraph,
  NodeChangeClassification,
  ResolvedConfig,
  SourceCanonicalNode,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import {
  audienceContains,
  audienceSets,
  formatAudience,
  resolveAudiences,
} from "./audience.js";
import { matchesAny, normalizePath } from "./glob.js";
import {
  descendantsOf,
  nodeFingerprint,
  semanticFingerprint,
} from "./graph.js";
import type { SourceTermNode } from "./types.js";
import { LEVEL_AUTHORITY, firstAbsentLevel } from "./frontier.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { stagedChanges } from "./git.js";
import {
  expectedSynchronizedNodes,
  expectedSynchronizedTerms,
  synchronizationDiagnostics,
} from "./sync.js";
import {
  buildVocabulary,
  resolveMarks,
  semanticTermFingerprint,
  termFingerprint,
} from "./terms.js";
import { unmarkedUseDiagnostics } from "./vocabulary.js";

function emptyClassification(): NodeChangeClassification {
  return {
    semantic: new Set(),
    synchronizationOnly: new Set(),
    added: new Set(),
    deleted: new Set(),
    changedPaths: new Map(),
  };
}

export function classifyNodeChanges(
  head?: KnowledgeGraph,
  staged?: KnowledgeGraph,
): NodeChangeClassification {
  const result = emptyClassification();
  const ids = new Set([...(head?.nodes.keys() ?? []), ...(staged?.nodes.keys() ?? [])]);
  for (const id of ids) {
    const before = head?.nodes.get(id);
    const after = staged?.nodes.get(id);
    if (!before && after) {
      result.semantic.add(id);
      result.added.add(id);
      result.changedPaths.set(id, after.sourcePath);
      continue;
    }
    if (before && !after) {
      result.semantic.add(id);
      result.deleted.add(id);
      result.changedPaths.set(id, before.sourcePath);
      continue;
    }
    if (!before || !after) continue;
    if (before.sourcePath !== after.sourcePath) result.changedPaths.set(id, after.sourcePath);
    if (semanticFingerprint(before) !== semanticFingerprint(after)) {
      result.semantic.add(id);
      result.changedPaths.set(id, after.sourcePath);
    } else if (nodeFingerprint(before) !== nodeFingerprint(after)) {
      result.synchronizationOnly.add(id);
      result.changedPaths.set(id, after.sourcePath);
    }
  }
  return result;
}

/**
 * Term changes join the same classification the trailers and PL2105 read, so a
 * definition edit takes a Knowledge-Change trailer and a digest-only rewrite
 * of a term file does not. Ids never collide: term ids carry their own prefix.
 */
export function classifyTermChanges(
  result: NodeChangeClassification,
  head: SourceTermNode[],
  staged: SourceTermNode[],
): NodeChangeClassification {
  const headById = new Map(head.map((term) => [term.id, term]));
  const stagedById = new Map(staged.map((term) => [term.id, term]));
  for (const id of new Set([...headById.keys(), ...stagedById.keys()])) {
    const before = headById.get(id);
    const after = stagedById.get(id);
    if (!before && after) {
      result.semantic.add(id);
      result.added.add(id);
      result.changedPaths.set(id, after.sourcePath);
      continue;
    }
    if (before && !after) {
      result.semantic.add(id);
      result.deleted.add(id);
      result.changedPaths.set(id, before.sourcePath);
      continue;
    }
    if (!before || !after) continue;
    if (before.sourcePath !== after.sourcePath) result.changedPaths.set(id, after.sourcePath);
    if (semanticTermFingerprint(before) !== semanticTermFingerprint(after)) {
      result.semantic.add(id);
      result.changedPaths.set(id, after.sourcePath);
    } else if (termFingerprint(before) !== termFingerprint(after)) {
      result.synchronizationOnly.add(id);
      result.changedPaths.set(id, after.sourcePath);
    }
  }
  return result;
}

function isGoverned(config: ResolvedConfig, file: string): boolean {
  return (
    matchesAny(file, config.governedPaths.include) &&
    !matchesAny(file, config.governedPaths.exclude)
  );
}

function ownersForFile(graph: KnowledgeGraph | undefined, file: string): SourceCanonicalNode[] {
  if (!graph) return [];
  return [...graph.nodes.values()].filter(
    (node) =>
      node.level === "mechanism" &&
      node.implementation &&
      matchesAny(file, node.implementation.files),
  );
}

function changedCanonicalPaths(config: ResolvedConfig, changes: GitChange[]): Set<string> {
  const root = normalizePath(path.relative(config.root, config.knowledgeRoot));
  const prefixes = [...KNOWLEDGE_LEVELS].map(
    (level) => `${root}/${level}/`,
  );
  const output = new Set<string>();
  for (const change of changes) {
    if (prefixes.some((prefix) => change.path.startsWith(prefix)) && change.path.endsWith(".json")) {
      output.add(change.path);
    }
    if (
      change.oldPath &&
      prefixes.some((prefix) => change.oldPath!.startsWith(prefix)) &&
      change.oldPath.endsWith(".json")
    ) {
      output.add(change.oldPath);
    }
  }
  return output;
}


export async function checkStagedCommit(config: ResolvedConfig): Promise<CommitCheckResult> {
  const headSnapshot = await createSnapshot(config, "head");
  const stagedSnapshot = await createSnapshot(config, "staged");
  const headValidation = await validateSnapshot(config, headSnapshot);
  const stagedValidation = await validateSnapshot(config, stagedSnapshot);
  const changes = await stagedChanges(config.root);
  const nodeChanges = classifyTermChanges(
    classifyNodeChanges(headValidation.graph, stagedValidation.graph),
    headValidation.terms,
    stagedValidation.terms,
  );
  const diagnostics: Diagnostic[] = [...stagedValidation.diagnostics];
  const changedImplementationFiles = changes.filter(
    (change) => isGoverned(config, change.path) || Boolean(change.oldPath && isGoverned(config, change.oldPath)),
  );

  if (!stagedValidation.graph || diagnostics.some((item) => item.severity === "error")) {
    return { diagnostics, nodeChanges, changedImplementationFiles };
  }

  diagnostics.push(
    ...(await synchronizationDiagnostics(
      stagedValidation.graph,
      stagedSnapshot,
      "product-lint knowledge sync --staged",
      headSnapshot,
      stagedValidation.terms,
    )),
  );

  const changedNodeIds = new Set([
    ...nodeChanges.semantic,
    ...nodeChanges.synchronizationOnly,
    ...nodeChanges.added,
    ...nodeChanges.deleted,
  ]);

  // "Create a Mechanism node for this file" is a legal instruction only when the
  // graph has an Architecture level to hang one from. PL1104 forbids a parentless
  // Mechanism, so on a graph that stops short of Architecture the advice below
  // sent an agent to build a node this same validator then rejected — once per
  // file. A repository that adopts Product Lint with code already in it hits
  // exactly that, N times, and the one true next action (ask about Context) is
  // absent from the output entirely. So when the level cannot exist yet, collect
  // the files and report the frontier once, after the loop.
  const canOwnMechanism = [...stagedValidation.graph.nodes.values()].some(
    (node) => node.level === "architecture",
  );
  const ungoverned: string[] = [];

  for (const change of changedImplementationFiles) {
    const paths = [change.path, ...(change.oldPath ? [change.oldPath] : [])];
    const owners = new Map<string, SourceCanonicalNode>();
    for (const file of paths) {
      for (const owner of ownersForFile(headValidation.graph, file)) owners.set(owner.id, owner);
      for (const owner of ownersForFile(stagedValidation.graph, file)) owners.set(owner.id, owner);
    }
    if (owners.size === 0) {
      if (!canOwnMechanism) {
        ungoverned.push(change.path);
        continue;
      }
      diagnostics.push({
        code: "PL2101 UNMAPPED_STAGED_FILE",
        severity: "error",
        message: `${paths.join(" -> ")} changed but has no Mechanism owner.`,
        path: change.path,
        action: "edit-node",
        expectedPath: "docs/mechanism/*.json",
      });
      continue;
    }
    for (const owner of owners.values()) {
      if (!changedNodeIds.has(owner.id)) {
        diagnostics.push({
          code: "PL2102 STALE_STAGED_MECHANISM",
          severity: "error",
          message: `${change.path} changed, but governing node ${owner.id} is not staged.`,
          path: change.path,
          nodeId: owner.id,
          action: "run-command",
          command: "product-lint knowledge sync --staged",
        });
      }
    }
  }

  if (ungoverned.length > 0) {
    const level = firstAbsentLevel(stagedValidation.graph) ?? "architecture";
    const authority = LEVEL_AUTHORITY[level];
    diagnostics.push({
      code: "PL2106 UNGOVERNED_IMPLEMENTATION",
      severity: "error",
      message:
        `${ungoverned.length} staged file(s) have no Mechanism owner, and no Mechanism node can ` +
        `own them yet because the graph has no ${level} level.`,
      requiredLevel: level,
      action: authority.action,
      infer: authority.infer,
      question: authority.question,
      expectedPath: `docs/${level}/*.json`,
      details: { files: [...ungoverned].sort() },
    });
  }

  for (const id of nodeChanges.semantic) {
    const affected = new Set<string>();
    // A term's dependents are not children — a term has none — but every text
    // that speaks the word: statements that mark it, and definitions that mark
    // it. Same rule as a parent change, read through the marks.
    if (id.startsWith("term.")) {
      for (const dependent of termDependents(headValidation.graph, headValidation.terms, id)) {
        affected.add(dependent);
      }
      for (const dependent of termDependents(stagedValidation.graph, stagedValidation.terms, id)) {
        affected.add(dependent);
      }
    }
    if (headValidation.graph?.nodes.has(id)) {
      for (const child of descendantsOf(headValidation.graph, [id])) affected.add(child);
    }
    if (stagedValidation.graph.nodes.has(id)) {
      for (const child of descendantsOf(stagedValidation.graph, [id])) affected.add(child);
    }
    affected.delete(id);
    for (const dependent of affected) {
      if (!changedNodeIds.has(dependent)) {
        diagnostics.push({
          code: "PL2103 STALE_DEPENDENT",
          severity: "error",
          message: `${id} changed, but affected dependent ${dependent} is not staged.`,
          nodeId: dependent,
          action: "run-command",
          command: "product-lint knowledge sync --staged",
          details: { changedNode: id },
        });
      }
    }
  }

  if (headValidation.graph) {
    const expectedHead = await expectedSynchronizedNodes(
      headValidation.graph,
      headSnapshot,
      undefined,
      headValidation.terms,
    );
    const expectedStaged = await expectedSynchronizedNodes(
      stagedValidation.graph,
      stagedSnapshot,
      undefined,
      stagedValidation.terms,
    );
    const expectedHeadTerms = expectedSynchronizedTerms(headValidation.terms);
    const expectedStagedTerms = expectedSynchronizedTerms(stagedValidation.terms);
    for (const id of nodeChanges.synchronizationOnly) {
      const before = expectedHead.get(id);
      const after = expectedStaged.get(id);
      if (before && after && nodeFingerprint(before) === nodeFingerprint(after)) {
        diagnostics.push({
          code: "PL2104 SPURIOUS_SYNC",
          severity: "error",
          message: `${id} contains a synchronization-only change without a changed input.`,
          nodeId: id,
          path: stagedValidation.graph.nodes.get(id)?.sourcePath,
        });
      }
      const beforeTerm = expectedHeadTerms.get(id);
      const afterTerm = expectedStagedTerms.get(id);
      if (beforeTerm && afterTerm && termFingerprint(beforeTerm) === termFingerprint(afterTerm)) {
        diagnostics.push({
          code: "PL2104 SPURIOUS_SYNC",
          severity: "error",
          message: `${id} contains a synchronization-only change without a changed input.`,
          nodeId: id,
          path: afterTerm.sourcePath,
        });
      }
    }
  }

  const canonicalPaths = changedCanonicalPaths(config, changes);
  for (const file of canonicalPaths) {
    const represented = [...nodeChanges.changedPaths.values()].includes(file);
    if (!represented) {
      diagnostics.push({
        code: "PL2105 FORMAT_ONLY_NODE_CHANGE",
        severity: "error",
        message: `${file} changed without a semantic or synchronization change.`,
        path: file,
        action: "run-command",
        command: "product-lint knowledge sync --staged",
      });
    }
  }

  diagnostics.push(...widenedAudiences(headValidation.graph, stagedValidation.graph));

  // The one moment a mark costs two characters in a file already open and
  // already owed a trailer. Info only, scoped to the statements this diff
  // touches; the standing backlog stays in `product-lint vocabulary`.
  const changedStatementNodes = [...stagedValidation.graph.nodes.values()].filter((node) =>
    nodeChanges.semantic.has(node.id),
  );
  diagnostics.push(...unmarkedUseDiagnostics(changedStatementNodes, stagedValidation.terms));

  return { diagnostics, nodeChanges, changedImplementationFiles };
}

/** Every id whose text marks the term: statements in the graph, definitions in the vocabulary. */
function termDependents(
  graph: KnowledgeGraph | undefined,
  terms: SourceTermNode[],
  termId: string,
): string[] {
  const vocabulary = buildVocabulary(terms);
  if (!vocabulary.byId.has(termId)) return [];
  const ids: string[] = [];
  for (const node of graph?.nodes.values() ?? []) {
    if (resolveMarks(node.statement, vocabulary).terms.some((term) => term.id === termId)) {
      ids.push(node.id);
    }
  }
  for (const term of terms) {
    if (term.id === termId) continue;
    if (resolveMarks(term.definition, vocabulary).terms.some((used) => used.id === termId)) {
      ids.push(term.id);
    }
  }
  return ids;
}

/**
 * A node whose audience grew.
 *
 * Audience below Context is the union of a node's parents, so adding a parent
 * can only widen and never narrow, and it does so without changing a single
 * word of the node itself. That is the mirror of the reason wildcards exist: in
 * both cases the meaning moves while the statement stands still. This one is
 * decidable — the two graphs are right here — so it is reported rather than
 * instructed, as a warning, because widening is often exactly what was wanted.
 */
export function widenedAudiences(
  head: KnowledgeGraph | undefined,
  staged: KnowledgeGraph | undefined,
): Diagnostic[] {
  if (!head || !staged) return [];
  const before = resolveAudiences(head);
  const after = resolveAudiences(staged);
  const axes = [...new Set([...audienceSets(head).keys(), ...audienceSets(staged).keys()])].sort();
  if (axes.length === 0) return [];

  const diagnostics: Diagnostic[] = [];
  for (const [id, node] of staged.nodes) {
    if (node.level === "audience" || node.level === "context") continue;
    const was = before.get(id);
    const now = after.get(id);
    if (!was || !now || was.length === 0) continue;
    if (audienceContains(was, now, axes)) continue;
    diagnostics.push({
      code: "PL2107 AUDIENCE_WIDENED",
      severity: "warning",
      message: `${id} now serves a wider audience than it did at HEAD.`,
      nodeId: id,
      path: node.sourcePath,
      action: "inspect",
      details: {
        before: formatAudience(was, axes),
        after: formatAudience(now, axes),
      },
    });
  }
  return diagnostics;
}

function parseCommitMessage(text: string, trailer: string): {
  declared: Set<string>;
  subject: string;
  body: string;
  duplicates: string[];
} {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const declared = new Set<string>();
  const duplicates: string[] = [];
  const trailerPattern = new RegExp(`^${trailer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(\\S+)\\s*$`);
  const trailerIndexes = new Set<number>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]?.match(trailerPattern);
    if (!match) continue;
    const id = match[1]!;
    if (declared.has(id)) duplicates.push(id);
    declared.add(id);
    trailerIndexes.add(index);
  }
  const meaningful = lines.map((line, index) => ({ line, index })).filter(
    ({ line }) => line.trim().length > 0 && !line.trimStart().startsWith("#"),
  );
  const firstNonEmpty = meaningful[0]?.index ?? -1;
  const body = lines
    .filter(
      (line, index) =>
        index !== firstNonEmpty &&
        !trailerIndexes.has(index) &&
        !line.trimStart().startsWith("#"),
    )
    .join("\n")
    .trim();
  const subject = firstNonEmpty >= 0 ? lines[firstNonEmpty]!.trim() : "";
  return { declared, subject, body, duplicates };
}

export async function checkCommitMessage(
  config: ResolvedConfig,
  messageFile: string,
): Promise<CommitMessageResult> {
  const message = await readFile(messageFile, "utf8");
  const staged = await checkStagedCommit(config);
  const semantic = staged.nodeChanges.semantic;
  const parsed = parseCommitMessage(message, config.commit.trailer);
  const diagnostics: Diagnostic[] = [...staged.diagnostics];

  for (const id of parsed.duplicates) {
    diagnostics.push({
      code: "PL2201 DUPLICATE_KNOWLEDGE_TRAILER",
      severity: "error",
      message: `Duplicate ${config.commit.trailer} trailer for ${id}.`,
      nodeId: id,
    });
  }
  for (const id of semantic) {
    if (!parsed.declared.has(id)) {
      diagnostics.push({
        code: "PL2202 MISSING_KNOWLEDGE_TRAILER",
        severity: "error",
        message: `Semantic node change is missing ${config.commit.trailer}: ${id}`,
        nodeId: id,
      });
    }
  }
  for (const id of parsed.declared) {
    if (!semantic.has(id)) {
      diagnostics.push({
        code: "PL2203 SPURIOUS_KNOWLEDGE_TRAILER",
        severity: "error",
        message: `${config.commit.trailer} declares ${id}, but it has no semantic staged change.`,
        nodeId: id,
      });
    }
  }
  if (config.commit.subjectPattern) {
    let pattern: RegExp | undefined;
    try {
      pattern = new RegExp(config.commit.subjectPattern);
    } catch (error) {
      diagnostics.push({
        code: "PL2206 INVALID_SUBJECT_PATTERN",
        severity: "error",
        message: `commit.subjectPattern is not a valid regular expression: ${String(error)}`,
        path: config.configPath,
      });
    }
    if (pattern && !pattern.test(parsed.subject)) {
      diagnostics.push({
        code: "PL2205 SUBJECT_PATTERN_MISMATCH",
        severity: "error",
        message: `Commit subject does not match the configured convention ${config.commit.subjectPattern}.`,
        action: "edit-node",
        details: { subject: parsed.subject, subjectPattern: config.commit.subjectPattern },
      });
    }
  }
  if (config.commit.requireBody && semantic.size > 0 && parsed.body.length === 0) {
    diagnostics.push({
      code: "PL2204 MISSING_KNOWLEDGE_REASON",
      severity: "error",
      message: "Knowledge-changing commits require a non-empty explanatory body.",
    });
  }

  return { diagnostics, declared: parsed.declared, semantic };
}
