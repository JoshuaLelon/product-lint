import type {
  Diagnostic,
  FrontierResult,
  KnowledgeGraph,
  KnowledgeLevel,
  RepositorySnapshot,
  ResolvedConfig,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import { matchesAny } from "./glob.js";

export function governedFiles(config: ResolvedConfig, snapshot: RepositorySnapshot): string[] {
  return snapshot.files.filter(
    (file) =>
      matchesAny(file, config.governedPaths.include) &&
      !matchesAny(file, config.governedPaths.exclude),
  );
}

export function filesForMechanism(
  graph: KnowledgeGraph,
  nodeId: string,
  snapshot: RepositorySnapshot,
): string[] {
  const node = graph.nodes.get(nodeId);
  if (!node || node.level !== "mechanism" || !node.implementation) return [];
  return snapshot.files
    .filter((file) => matchesAny(file, node.implementation!.files))
    .sort();
}

function missingChildDiagnostic(nodeId: string, requiredLevel: KnowledgeLevel): Diagnostic {
  const definitions: Record<KnowledgeLevel, { question: string; action: "ask-user" | "edit-node"; infer: boolean }> = {
    context: {
      question: "Who is this product for, and what problem are they trying to solve?",
      action: "ask-user",
      infer: false,
    },
    product: {
      question: "What must the product make true to address this context?",
      action: "ask-user",
      infer: false,
    },
    behavior: {
      question: "What should a user, client, or system be able to observe or do because this product rule exists?",
      action: "ask-user",
      infer: false,
    },
    architecture: {
      question: "What responsibility, boundary, or ownership model is required to support this behavior?",
      action: "edit-node",
      infer: true,
    },
    mechanism: {
      question: "What concrete implementation mechanism realizes this architecture?",
      action: "edit-node",
      infer: true,
    },
  };
  const definition = definitions[requiredLevel];
  const codeByLevel: Record<KnowledgeLevel, string> = {
    context: "PL0001 MISSING_CONTEXT",
    product: "PL0101 MISSING_PRODUCT",
    behavior: "PL0201 MISSING_BEHAVIOR",
    architecture: "PL0301 MISSING_ARCHITECTURE",
    mechanism: "PL0401 MISSING_MECHANISM",
  };
  return {
    code: codeByLevel[requiredLevel],
    severity: "info",
    message: `${nodeId} has no direct ${requiredLevel} descendant.`,
    frontier: nodeId,
    requiredLevel,
    action: definition.action,
    infer: definition.infer,
    question: definition.question,
    expectedPath: `docs/${requiredLevel}/*.json`,
    command: "git add docs && product-lint knowledge sync --staged",
    details: {
      nodeTemplate: {
        schemaVersion: 1,
        id: `${requiredLevel}.<semantic-id>`,
        level: requiredLevel,
        kind: "<kind>",
        statement: "<one coherent statement>",
        constrainedBy: [nodeId],
        sync: { constraintsDigest: "pending" },
      },
    },
  };
}

export function detectFrontier(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
): FrontierResult {
  const diagnostics: Diagnostic[] = [];
  const contextNodes = [...graph.nodes.values()].filter((node) => node.level === "context");
  if (contextNodes.length === 0) {
    diagnostics.push({
      code: "PL0001 MISSING_CONTEXT",
      severity: "info",
      message: "No canonical Context nodes exist.",
      requiredLevel: "context",
      action: "ask-user",
      infer: false,
      question: "Who is this product for, and what problem are they trying to solve?",
      expectedPath: "docs/context/*.json",
      command: "git add docs && product-lint knowledge sync --staged",
      details: {
        nodeTemplate: {
          schemaVersion: 1,
          id: "context.<semantic-id>",
          level: "context",
          kind: "customer-or-problem",
          statement: "<user-supplied context statement>",
          constrainedBy: [],
          sync: { constraintsDigest: "pending" },
        },
      },
    });
    return { complete: false, diagnostics };
  }

  for (let index = 0; index < KNOWLEDGE_LEVELS.length - 1; index += 1) {
    const level = KNOWLEDGE_LEVELS[index]!;
    const nextLevel = KNOWLEDGE_LEVELS[index + 1]!;
    for (const node of graph.nodes.values()) {
      if (node.level !== level) continue;
      const hasNextLevelChild = [...(graph.children.get(node.id) ?? [])].some(
        (childId) => graph.nodes.get(childId)?.level === nextLevel,
      );
      if (!hasNextLevelChild) diagnostics.push(missingChildDiagnostic(node.id, nextLevel));
    }
  }

  for (const node of graph.nodes.values()) {
    if (node.level !== "mechanism") continue;
    const files = filesForMechanism(graph, node.id, snapshot);
    if (!node.implementation || node.implementation.files.length === 0 || files.length === 0) {
      diagnostics.push({
        code: "PL0501 MISSING_IMPLEMENTATION",
        severity: "info",
        message: `${node.id} does not resolve to implementation files.`,
        nodeId: node.id,
        frontier: node.id,
        requiredLevel: "implementation",
        action: "edit-node",
        infer: true,
        question: "Which repository files implement this mechanism?",
        expectedPath: node.sourcePath,
        details: {
          implementationTemplate: {
            files: ["<repository-path-or-glob>"],
            digest: "pending",
          },
        },
      });
    }
  }

  const mechanisms = [...graph.nodes.values()].filter((node) => node.level === "mechanism");
  for (const file of governedFiles(config, snapshot)) {
    const owners = mechanisms.filter(
      (node) => node.implementation && matchesAny(file, node.implementation.files),
    );
    if (owners.length === 0) {
      diagnostics.push({
        code: "PL0601 UNMAPPED_FILE",
        severity: "info",
        message: `${file} is governed but has no Mechanism owner.`,
        path: file,
        requiredLevel: "mechanism",
        action: "edit-node",
        infer: true,
        question: "Which mechanism owns this implementation file?",
        expectedPath: "docs/mechanism/*.json",
        command: "git add docs && product-lint knowledge sync --staged",
        details: {
          file,
          requirement: "Create or update a Mechanism node whose implementation.files matches this path.",
        },
      });
    }
  }

  return { complete: diagnostics.length === 0, diagnostics };
}
