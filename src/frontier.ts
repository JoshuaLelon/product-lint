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

/**
 * Who owns the answer at each level, and what to ask for it.
 *
 * Context, Product, and Behavior state user intent, so `infer` is false and an
 * agent must ask. Architecture and Mechanism follow from the code, so an agent
 * drafts them. The commit path reads this too — an unmapped file on a graph
 * with no Architecture level is really a frontier question, and it must ask it
 * with the same words the frontier would.
 */
export const LEVEL_AUTHORITY: Record<
  KnowledgeLevel,
  { question: string; action: "ask-user" | "edit-node"; infer: boolean }
> = {
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

/**
 * The shallowest level with no nodes at all. An empty repository returns
 * "context"; a repository whose knowledge stops at Behavior returns
 * "architecture". Undefined means every level is populated.
 */
export function firstAbsentLevel(graph: KnowledgeGraph): KnowledgeLevel | undefined {
  return KNOWLEDGE_LEVELS.find(
    (level) => ![...graph.nodes.values()].some((node) => node.level === level),
  );
}

function missingChildDiagnostic(nodeId: string, requiredLevel: KnowledgeLevel): Diagnostic {
  const definitions = LEVEL_AUTHORITY;
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
          statement: "<user-supplied context statement>",
          constrainedBy: [],
          sync: { constraintsDigest: "pending" },
        },
      },
    });
    // Context is the only question worth asking here, so the level walk below is
    // skipped — but the ungoverned files are a FACT about this repository, not a
    // later question, and returning without them is how `ship` came to report
    // MISSING_CONTEXT alone on a repository with 341 unowned files. One
    // diagnostic, with the tree, so the size of the job is visible from the start.
    diagnostics.push(...ungovernedDiagnostics(config, graph, snapshot));
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

  diagnostics.push(...ungovernedDiagnostics(config, graph, snapshot));

  return { complete: diagnostics.length === 0, diagnostics };
}

/**
 * Governed files with no Mechanism owner.
 *
 * One `PL0601` per file is the right shape when the graph can actually own the
 * file: the fix is per-file, and a tool consuming `--json` wants one entry each.
 * It is the wrong shape when no Mechanism node can exist yet, because then all
 * of them share ONE cause and ONE repair, and a repository adopting Product Lint
 * with code already in it would get hundreds of identical rows telling it to do
 * something `PL1104` forbids. That case collapses to a single `PL0602` carrying
 * the whole list, which `formatDiagnostic` renders as a tree.
 */
function ungovernedDiagnostics(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
): Diagnostic[] {
  const mechanisms = [...graph.nodes.values()].filter((node) => node.level === "mechanism");
  const ungoverned = governedFiles(config, snapshot).filter(
    (file) =>
      !mechanisms.some(
        (node) => node.implementation && matchesAny(file, node.implementation.files),
      ),
  );
  if (ungoverned.length === 0) return [];

  const canOwnMechanism = [...graph.nodes.values()].some((node) => node.level === "architecture");
  if (!canOwnMechanism) {
    const level = firstAbsentLevel(graph) ?? "architecture";
    const authority = LEVEL_AUTHORITY[level];
    return [
      {
        code: "PL0602 UNGOVERNED_TREE",
        severity: "info",
        message:
          `${ungoverned.length} governed file(s) have no Mechanism owner, and no Mechanism node ` +
          `can own them yet because the graph has no ${level} level.`,
        requiredLevel: level,
        action: authority.action,
        infer: authority.infer,
        question: authority.question,
        expectedPath: `docs/${level}/*.json`,
        details: { files: ungoverned },
      },
    ];
  }

  return ungoverned.map((file) => ({
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
  }));
}
