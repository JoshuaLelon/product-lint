import type {
  Diagnostic,
  FrontierResult,
  KnowledgeGraph,
  KnowledgeLevel,
  RepositorySnapshot,
  ResolvedConfig,
  SourceTermNode,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import type { ResolvedScope } from "./scope.js";
import { audienceOverlaps, audienceSets, resolveAudiences } from "./audience.js";
import { matchesAny } from "./glob.js";
import { levelIndex } from "./terms.js";

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
  audience: {
    question:
      "Who is this product for? Name the sets that distinguish them, and the values in each set.",
    action: "ask-user",
    infer: false,
  },
  // Context used to ask who AND why in one question, which is two claims that
  // can be false independently — the same fault the one-thing rule forbids in a
  // statement. Who now has its own level, and Context asks only why.
  context: {
    question: "What problem is this audience trying to solve?",
    action: "ask-user",
    infer: false,
  },
  product: {
    question: "What must the product make true to address this context?",
    action: "ask-user",
    infer: false,
  },
  // This question used to ask what someone "should be able to" observe or do,
  // which invites the Product rule back in different verbs — a capability is
  // just a promise with a modal in front of it. A Behavior that restates its
  // parent leaves the level below it empty while the graph looks full. The
  // occasion is what divides the two: a Product rule holds everywhere, and a
  // Behavior happens somewhere, so the question asks for when.
  behavior: {
    question:
      "What must a user, client, or system observe or do, and on what occasion, because this product rule holds?",
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

/**
 * Every node that already sits at a level, for the diagnostic that is about to
 * add one more.
 *
 * NODE_SHAPE tells an agent to read the nodes already at the level before
 * writing a sibling, and until now nothing showed them. That gap has a known
 * cost: an agent mined a level it had not re-read and produced three duplicate
 * pairs, each of which read correct alone. The rule and the set it refers to
 * have to arrive together, or the rule is advice about information the reader
 * does not have.
 *
 * Capped, and the cap is stated, for the same reason the file tree states its
 * own limits: a list that silently stops reads as a complete list.
 */
const LEVEL_SAMPLE_LIMIT = 20;

function nodesAtLevel(
  graph: KnowledgeGraph,
  level: KnowledgeLevel,
): { total: number; shown: { id: string; statement: string }[] } {
  const all = [...graph.nodes.values()]
    .filter((node) => node.level === level)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return {
    total: all.length,
    shown: all
      .slice(0, LEVEL_SAMPLE_LIMIT)
      .map((node) => ({ id: node.id, statement: node.statement })),
  };
}

/**
 * The terms a statement at this level may use: its own level and above. Shown
 * beside the level for the same reason the level is shown — the vocabulary
 * rule says to read the terms in scope before coining a word, and synonym
 * prevention happens here, before the write, not in a check after it.
 */
function termsInScope(
  terms: SourceTermNode[],
  level: KnowledgeLevel,
): {
  total: number;
  shown: {
    id: string;
    level: string;
    name: string;
    definition: string;
    borrowed?: string;
    rejected: string[];
  }[];
} {
  const inScope = terms
    .filter((term) => levelIndex(term.level) <= levelIndex(level))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    total: inScope.length,
    shown: inScope.slice(0, LEVEL_SAMPLE_LIMIT).map((term) => ({
      id: term.id,
      level: term.level,
      name: term.name,
      definition: term.definition,
      ...(term.borrowed ? { borrowed: term.borrowed } : {}),
      // Names and stances only. This surface is scanned to answer "does a word
      // for this already exist" — the names alone answer it, and twenty terms
      // carrying every reason would bury the definitions the block exists for.
      // The reasons are one file away, and the llms views print them in full.
      rejected: term.rejected.map((item) => `${item.name} (${item.stance})`),
    })),
  };
}

function missingChildDiagnostic(
  nodeId: string,
  requiredLevel: KnowledgeLevel,
  graph: KnowledgeGraph,
  terms: SourceTermNode[],
): Diagnostic {
  const definitions = LEVEL_AUTHORITY;
  const definition = definitions[requiredLevel];
  const codeByLevel: Record<KnowledgeLevel, string> = {
    audience: "PL0011 MISSING_AUDIENCE",
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
      level: nodesAtLevel(graph, requiredLevel),
      ...(terms.length > 0 ? { termsInScope: termsInScope(terms, requiredLevel) } : {}),
    },
  };
}

export function detectFrontier(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  snapshot: RepositorySnapshot,
  terms: SourceTermNode[] = [],
  scope?: ResolvedScope,
): FrontierResult {
  const diagnostics: Diagnostic[] = [];
  // Held back rather than dropped. A report that stops without saying so reads
  // as a complete report, which is how a scoped repository would come to look
  // finished at 20% built.
  let deferred = 0;
  const withScope = (result: Omit<FrontierResult, "scope">): FrontierResult =>
    scope
      ? {
          ...result,
          scope: {
            roots: scope.roots,
            because: scope.because,
            deferredRoots: scope.deferredRoots,
            deferred,
            contested: scope.contested.length,
          },
        }
      : result;
  const rootLevel = KNOWLEDGE_LEVELS[0];
  const contextNodes = [...graph.nodes.values()].filter((node) => node.level === rootLevel);
  if (contextNodes.length === 0) {
    diagnostics.push({
      code: "PL0011 MISSING_AUDIENCE",
      severity: "info",
      message: `No canonical ${rootLevel} nodes exist.`,
      requiredLevel: rootLevel,
      action: "ask-user",
      infer: false,
      question: LEVEL_AUTHORITY[rootLevel].question,
      expectedPath: `docs/${rootLevel}/*.json`,
      command: "git add docs && product-lint knowledge sync --staged",
      details: {
        nodeTemplate: {
          schemaVersion: 1,
          id: `${rootLevel}.<set>.<value>`,
          level: rootLevel,
          statement: `<user-supplied ${rootLevel} statement>`,
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
    diagnostics.push(...ungovernedDiagnostics(config, graph, snapshot, scope));
    return withScope({ complete: false, diagnostics });
  }

  // An audience value is covered when some Context's SELECTOR reaches it, which
  // is not the same as having a child edge: a Context that names `role.*` leaves
  // no edge to any single role, and a Context that names one set leaves none to
  // the other set's values at all. Reading edges here reported every value the
  // graph covers by description rather than by name as uncovered.
  const audiences = resolveAudiences(graph);
  const axes = [...audienceSets(graph).keys()].sort();
  const contextAudiences = [...graph.nodes.values()]
    .filter((node) => node.level === "context")
    .map((node) => audiences.get(node.id) ?? []);

  for (let index = 0; index < KNOWLEDGE_LEVELS.length - 1; index += 1) {
    const level = KNOWLEDGE_LEVELS[index]!;
    const nextLevel = KNOWLEDGE_LEVELS[index + 1]!;
    for (const node of graph.nodes.values()) {
      if (node.level !== level) continue;
      const covered =
        level === "audience"
          ? contextAudiences.some((context) =>
              audienceOverlaps(context, audiences.get(node.id) ?? [], axes),
            )
          : [...(graph.children.get(node.id) ?? [])].some(
              (childId) => graph.nodes.get(childId)?.level === nextLevel,
            );
      if (covered) continue;
      if (scope && !scope.inScope.has(node.id)) {
        deferred += 1;
        continue;
      }
      diagnostics.push(missingChildDiagnostic(node.id, nextLevel, graph, terms));
    }
  }

  for (const node of graph.nodes.values()) {
    if (node.level !== "mechanism") continue;
    const files = filesForMechanism(graph, node.id, snapshot);
    if (!node.implementation || node.implementation.files.length === 0 || files.length === 0) {
      if (scope && !scope.inScope.has(node.id)) {
        deferred += 1;
        continue;
      }
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

  diagnostics.push(...ungovernedDiagnostics(config, graph, snapshot, scope));
  const drafts = draftDiagnostics(graph, scope);
  diagnostics.push(...drafts.diagnostics);
  // A deferred placeholder is still a sentence someone owes. Leaving it out of
  // the tally printed "0 obligations" beside eleven unwritten statements, which
  // is the one thing the footer exists to prevent.
  deferred += drafts.deferred;

  // PL0604 is the one report that does not gate completeness. Every other entry
  // here is an obligation someone can discharge; that one is a fact nothing in
  // scope can act on, because the files it names belong to problems the config
  // says are not being built. It stays in the output at full volume so a green
  // `ship` never reads as "every file is owned".
  const gating = diagnostics.filter((item) => !item.code.startsWith("PL0604"));
  return withScope({ complete: gating.length === 0, diagnostics });
}

/**
 * PL0901/PL0902: what `adopt` wrote and has not been replaced.
 *
 * A draft is the most visible thing in the report, so it is not a hole — but it
 * is not done either, and `ship` means terminal completeness. Grouped one block
 * for all of them, the way PL0801 folds per term, because a spine is six nodes
 * and one adoption of a mid-sized repository would otherwise print a hundred
 * near-identical rows.
 */
function draftDiagnostics(
  graph: KnowledgeGraph,
  scope?: ResolvedScope,
): { diagnostics: Diagnostic[]; deferred: number } {
  const all = [...graph.nodes.values()]
    .filter((node) => node.draft)
    .sort((left, right) => left.id.localeCompare(right.id));
  const drafts = all.filter((node) => !scope || scope.inScope.has(node.id));
  const deferred = all.length - drafts.length;
  if (drafts.length === 0) return { diagnostics: [], deferred };

  // A draft whose statement is no longer the one `adopt` wrote has been
  // written, and only the flag was left behind. Reported apart, because its
  // repair is a deletion rather than a sentence — and left unreported it would
  // hold `ship` red forever for work that is finished.
  const written = drafts.filter((node) => node.statement !== placeholderStatement(node.level));
  const owing = drafts.filter((node) => node.statement === placeholderStatement(node.level));

  const diagnostics: Diagnostic[] = [];
  if (owing.length > 0) {
    // Grouped by level, shallowest first, because that is the order of leverage:
    // a context statement decides what every node under it is even for, and
    // writing an architecture placeholder before it is work you may throw away.
    // Sorting these by id instead put `architecture` at the top of the report.
    const byLevel = KNOWLEDGE_LEVELS.map((level) => ({
      level,
      question: LEVEL_AUTHORITY[level].question,
      ids: owing.filter((node) => node.level === level).map((node) => node.id),
    })).filter((group) => group.ids.length > 0);
    diagnostics.push({
      code: "PL0901 DRAFT_NODE",
      severity: "info",
      message: `${owing.length} placeholder statement(s) await a real one.`,
      action: "ask-user",
      details: { drafts: byLevel },
    });
  }
  if (written.length > 0) {
    diagnostics.push({
      code: "PL0902 DRAFT_LOOKS_WRITTEN",
      severity: "info",
      message: `${written.length} draft node(s) have a statement nobody generated. Drop the flag.`,
      action: "edit-node",
      details: {
        uses: written.map((node) => ({ id: node.id, statement: node.statement })),
      },
    });
  }
  return { diagnostics, deferred };
}

/**
 * What `adopt` writes into a node it cannot answer for. Deterministic per level
 * so PL0902 can tell a placeholder from a statement without storing a copy.
 */
export function placeholderStatement(level: KnowledgeLevel): string {
  return `TODO: ${LEVEL_AUTHORITY[level].question}`;
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
  scope?: ResolvedScope,
): Diagnostic[] {
  const mechanisms = [...graph.nodes.values()].filter((node) => node.level === "mechanism");
  const ungoverned = governedFiles(config, snapshot).filter(
    (file) =>
      !mechanisms.some(
        (node) => node.implementation && matchesAny(file, node.implementation.files),
      ),
  );
  if (ungoverned.length === 0) return [];

  // An unowned file has no lineage, so nothing can say which problem it serves.
  // Under scope that makes ownership undemandable rather than merely deferred:
  // the repair would be to build a subtree the config just said is not being
  // built. So it collapses to one line that states the size of the job and the
  // command that ends it, and it does not gate completeness.
  if (scope) {
    return [
      {
        code: "PL0604 UNGOVERNED_OUTSIDE_SCOPE",
        severity: "info",
        message:
          `${ungoverned.length} governed file(s) have no Mechanism owner. Scope cannot tell which ` +
          `problem they serve, because an unowned file has no lineage to read.`,
        action: "run-command",
        command: "product-lint adopt --all",
        details: { files: ungoverned },
      },
    ];
  }

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
