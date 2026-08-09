import path from "node:path";
import type {
  CanonicalNode,
  Diagnostic,
  KnowledgeGraph,
  KnowledgeLevel,
  RepositorySnapshot,
  ResolvedConfig,
  SourceCanonicalNode,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import { normalizePath } from "./glob.js";
import { digest, stableStringify } from "./stable-json.js";

const LEVEL_INDEX = new Map<KnowledgeLevel, number>(
  KNOWLEDGE_LEVELS.map((level, index) => [level, index]),
);

const CANONICAL_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "id",
  "level",
  "kind",
  "statement",
  "constrainedBy",
  "sync",
  "implementation",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseCanonicalNode(
  value: unknown,
  sourcePath: string,
  folderLevel: KnowledgeLevel,
): { node?: SourceCanonicalNode; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return {
      diagnostics: [
        {
          code: "PL1001 INVALID_NODE",
          severity: "error",
          message: "Canonical node must be a JSON object.",
          path: sourcePath,
        },
      ],
    };
  }

  for (const key of Object.keys(value)) {
    if (!CANONICAL_KEYS.has(key)) {
      diagnostics.push({
        code: "PL1002 UNKNOWN_NODE_FIELD",
        severity: "error",
        message: `Unknown canonical-node field: ${key}`,
        path: sourcePath,
      });
    }
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const level = typeof value.level === "string" ? value.level : "";
  const kind = typeof value.kind === "string" ? value.kind.trim() : "";
  const statement = typeof value.statement === "string" ? value.statement.trim() : "";
  const constrainedBy = Array.isArray(value.constrainedBy)
    ? value.constrainedBy.filter((item): item is string => typeof item === "string")
    : [];

  if (!id) {
    diagnostics.push({
      code: "PL1003 MISSING_NODE_ID",
      severity: "error",
      message: "Canonical node is missing a non-empty id.",
      path: sourcePath,
    });
  } else if (!/^(context|product|behavior|architecture|mechanism)\.[a-z0-9][a-z0-9._-]*$/.test(id)) {
    diagnostics.push({
      code: "PL1004 INVALID_NODE_ID",
      severity: "error",
      message: `Node id must begin with its level and use lowercase semantic identifiers: ${id}`,
      path: sourcePath,
      nodeId: id,
    });
  }

  if (!KNOWLEDGE_LEVELS.includes(level as KnowledgeLevel)) {
    diagnostics.push({
      code: "PL1005 INVALID_LEVEL",
      severity: "error",
      message: `Invalid level: ${String(value.level)}`,
      path: sourcePath,
      nodeId: id || undefined,
    });
  } else if (level !== folderLevel) {
    diagnostics.push({
      code: "PL1006 LEVEL_FOLDER_MISMATCH",
      severity: "error",
      message: `Node declares level ${level} but is stored under ${folderLevel}.`,
      path: sourcePath,
      nodeId: id || undefined,
    });
  }

  if (id && level && !id.startsWith(`${level}.`)) {
    diagnostics.push({
      code: "PL1007 ID_LEVEL_MISMATCH",
      severity: "error",
      message: `Node id ${id} does not match declared level ${level}.`,
      path: sourcePath,
      nodeId: id,
    });
  }

  if (!kind) {
    diagnostics.push({
      code: "PL1008 MISSING_KIND",
      severity: "error",
      message: "Canonical node is missing a non-empty kind.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  }
  if (!statement) {
    diagnostics.push({
      code: "PL1009 MISSING_STATEMENT",
      severity: "error",
      message: "Canonical node is missing a non-empty statement.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  }
  if (!Array.isArray(value.constrainedBy)) {
    diagnostics.push({
      code: "PL1010 MISSING_CONSTRAINTS",
      severity: "error",
      message: "Canonical node must define constrainedBy as an array.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  } else if (constrainedBy.length !== value.constrainedBy.length) {
    diagnostics.push({
      code: "PL1011 INVALID_CONSTRAINT",
      severity: "error",
      message: "Every constrainedBy entry must be a node id string.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  }

  let sync: CanonicalNode["sync"];
  if (value.sync !== undefined) {
    if (!isRecord(value.sync) || typeof value.sync.constraintsDigest !== "string") {
      diagnostics.push({
        code: "PL1012 INVALID_SYNC",
        severity: "error",
        message: "sync must contain a string constraintsDigest.",
        path: sourcePath,
        nodeId: id || undefined,
      });
    } else {
      sync = { constraintsDigest: value.sync.constraintsDigest };
    }
  }

  let implementation: CanonicalNode["implementation"];
  if (value.implementation !== undefined) {
    if (
      !isRecord(value.implementation) ||
      !Array.isArray(value.implementation.files) ||
      value.implementation.files.some((item) => typeof item !== "string") ||
      typeof value.implementation.digest !== "string"
    ) {
      diagnostics.push({
        code: "PL1013 INVALID_IMPLEMENTATION",
        severity: "error",
        message: "implementation must contain string[] files and a string digest.",
        path: sourcePath,
        nodeId: id || undefined,
      });
    } else {
      implementation = {
        files: value.implementation.files as string[],
        digest: value.implementation.digest,
      };
    }
  }

  if (level !== "mechanism" && implementation !== undefined) {
    diagnostics.push({
      code: "PL1014 IMPLEMENTATION_ON_NON_MECHANISM",
      severity: "error",
      message: "Only Mechanism nodes may declare implementation ownership.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  }

  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics };

  return {
    node: {
      ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
      ...(value.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
      id,
      level: level as KnowledgeLevel,
      kind,
      statement,
      constrainedBy,
      ...(sync ? { sync } : {}),
      ...(implementation ? { implementation } : {}),
      sourcePath,
    },
    diagnostics,
  };
}

function relativeCanonicalRoots(config: ResolvedConfig): Record<KnowledgeLevel, string> {
  return Object.fromEntries(
    KNOWLEDGE_LEVELS.map((level) => [
      level,
      normalizePath(path.relative(config.root, config.canonicalRoots[level])),
    ]),
  ) as Record<KnowledgeLevel, string>;
}

export async function loadCanonicalNodes(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
): Promise<{ nodes: SourceCanonicalNode[]; diagnostics: Diagnostic[] }> {
  const roots = relativeCanonicalRoots(config);
  const diagnostics: Diagnostic[] = [];
  const nodes: SourceCanonicalNode[] = [];

  for (const level of KNOWLEDGE_LEVELS) {
    const prefix = `${roots[level]}/`;
    const files = snapshot.files.filter((file) => file.startsWith(prefix) && file.endsWith(".json"));
    for (const file of files) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(await snapshot.readFile(file)) as unknown;
      } catch (error) {
        diagnostics.push({
          code: "PL1000 INVALID_JSON",
          severity: "error",
          message: `Invalid JSON: ${String(error)}`,
          path: file,
        });
        continue;
      }
      const result = parseCanonicalNode(parsed, file, level);
      diagnostics.push(...result.diagnostics);
      if (result.node) nodes.push(result.node);
    }
  }

  return { nodes, diagnostics };
}

export function buildKnowledgeGraph(
  sourceNodes: SourceCanonicalNode[],
): { graph?: KnowledgeGraph; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const nodes = new Map<string, SourceCanonicalNode>();

  for (const node of sourceNodes) {
    const existing = nodes.get(node.id);
    if (existing) {
      diagnostics.push({
        code: "PL1101 DUPLICATE_NODE_ID",
        severity: "error",
        message: `Duplicate node id appears in ${existing.sourcePath} and ${node.sourcePath}.`,
        nodeId: node.id,
        path: node.sourcePath,
      });
    } else {
      nodes.set(node.id, node);
    }
  }

  const parents = new Map<string, Set<string>>();
  const children = new Map<string, Set<string>>();
  for (const id of nodes.keys()) {
    parents.set(id, new Set());
    children.set(id, new Set());
  }

  for (const node of nodes.values()) {
    const nodeIndex = LEVEL_INDEX.get(node.level)!;
    const immediateParentLevel = nodeIndex > 0 ? KNOWLEDGE_LEVELS[nodeIndex - 1] : undefined;
    let hasImmediateParent = node.level === "context";

    for (const parentId of node.constrainedBy) {
      const parent = nodes.get(parentId);
      if (!parent) {
        diagnostics.push({
          code: "PL1102 MISSING_CONSTRAINT_NODE",
          severity: "error",
          message: `constrainedBy references missing node ${parentId}.`,
          nodeId: node.id,
          path: node.sourcePath,
        });
        continue;
      }
      const parentIndex = LEVEL_INDEX.get(parent.level)!;
      if (parentIndex > nodeIndex) {
        diagnostics.push({
          code: "PL1103 ILLEGAL_DEPENDENCY_DIRECTION",
          severity: "error",
          message: `${node.id} (${node.level}) cannot depend on lower-level ${parent.id} (${parent.level}).`,
          nodeId: node.id,
          path: node.sourcePath,
        });
      }
      if (parent.level === immediateParentLevel) hasImmediateParent = true;
      parents.get(node.id)!.add(parentId);
      children.get(parentId)!.add(node.id);
    }

    if (!hasImmediateParent) {
      diagnostics.push({
        code: "PL1104 SKIPPED_KNOWLEDGE_LEVEL",
        severity: "error",
        message: `${node.id} must be directly constrained by at least one ${immediateParentLevel} node.`,
        nodeId: node.id,
        path: node.sourcePath,
        requiredLevel: immediateParentLevel,
      });
    }
  }

  const indegree = new Map<string, number>();
  for (const [id, values] of parents) indegree.set(id, values.size);
  const queue = [...nodes.keys()].filter((id) => indegree.get(id) === 0).sort();
  const topologicalOrder: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    topologicalOrder.push(id);
    for (const child of [...(children.get(id) ?? [])].sort()) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) {
        queue.push(child);
        queue.sort();
      }
    }
  }

  if (topologicalOrder.length !== nodes.size) {
    const cyclic = [...nodes.keys()].filter((id) => !topologicalOrder.includes(id));
    diagnostics.push({
      code: "PL1105 KNOWLEDGE_CYCLE",
      severity: "error",
      message: `Knowledge graph contains a cycle involving: ${cyclic.join(", ")}`,
      details: { nodes: cyclic },
    });
  }

  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics };
  return { graph: { nodes, parents, children, topologicalOrder }, diagnostics };
}

export function semanticProjection(node: CanonicalNode): Record<string, unknown> {
  return {
    id: node.id,
    level: node.level,
    kind: node.kind,
    statement: node.statement,
    constrainedBy: [...node.constrainedBy],
    ...(node.implementation ? { implementation: { files: [...node.implementation.files] } } : {}),
  };
}

export function semanticFingerprint(node: CanonicalNode): string {
  return digest(semanticProjection(node), "product-lint-semantic-v1");
}

export function nodeFingerprint(node: CanonicalNode): string {
  return digest(
    {
      ...semanticProjection(node),
      sync: node.sync ?? null,
      ...(node.implementation
        ? { implementation: { ...node.implementation, files: [...node.implementation.files] } }
        : {}),
    },
    "product-lint-node-v1",
  );
}

export function serializeNode(node: SourceCanonicalNode): string {
  const output: CanonicalNode = {
    ...(node.$schema ? { $schema: node.$schema } : {}),
    schemaVersion: 1,
    id: node.id,
    level: node.level,
    kind: node.kind,
    statement: node.statement,
    constrainedBy: [...node.constrainedBy],
    ...(node.sync ? { sync: node.sync } : {}),
    ...(node.implementation ? { implementation: node.implementation } : {}),
  };
  return `${stableStringify(output, 2)}\n`;
}

export function ancestorsOf(graph: KnowledgeGraph, startIds: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(graph.parents.get(id) ?? []));
  }
  return result;
}

export function descendantsOf(graph: KnowledgeGraph, startIds: Iterable<string>): Set<string> {
  const result = new Set<string>();
  const queue = [...startIds];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (result.has(id)) continue;
    result.add(id);
    queue.push(...(graph.children.get(id) ?? []));
  }
  return result;
}
