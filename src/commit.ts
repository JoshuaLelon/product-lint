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
import { matchesAny, normalizePath } from "./glob.js";
import {
  descendantsOf,
  nodeFingerprint,
  semanticFingerprint,
} from "./graph.js";
import { LEVEL_AUTHORITY, firstAbsentLevel } from "./frontier.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { stagedChanges } from "./git.js";
import { expectedSynchronizedNodes, synchronizationDiagnostics } from "./sync.js";
import { computeSpectrum } from "./spectrum.js";
import { compareToBaseline, readBaseline } from "./baseline.js";
import { attestationDiagnostics, loadAttestations } from "./attest.js";

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
  const prefixes = ["context", "product", "behavior", "architecture", "mechanism"].map(
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
  const nodeChanges = classifyNodeChanges(headValidation.graph, stagedValidation.graph);
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
    const expectedHead = await expectedSynchronizedNodes(headValidation.graph, headSnapshot);
    const expectedStaged = await expectedSynchronizedNodes(stagedValidation.graph, stagedSnapshot);
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

  // The ratchet, measured on the staged tree because that is the tree about to
  // become history. Per band and never summed: a total would let a commit that
  // closes two coverage gaps pay for the overlap it introduces, and separating
  // those is the whole reason the measurement is a vector.
  const spectrum = computeSpectrum({
    config,
    snapshot: stagedSnapshot,
    graph: stagedValidation.graph,
    diagnostics: stagedValidation.diagnostics,
  });
  diagnostics.push(...compareToBaseline(spectrum, await readBaseline(config.root)));

  const attestations = await loadAttestations(config, stagedSnapshot);
  diagnostics.push(
    ...attestations.diagnostics,
    ...attestationDiagnostics(config, stagedValidation.graph, attestations.attestations),
  );

  return { diagnostics, nodeChanges, changedImplementationFiles };
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
