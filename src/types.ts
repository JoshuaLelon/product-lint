export const KNOWLEDGE_LEVELS = [
  "audience",
  "context",
  "product",
  "behavior",
  "architecture",
  "mechanism",
] as const;

export type KnowledgeLevel = (typeof KNOWLEDGE_LEVELS)[number];

export interface NodeSyncState {
  constraintsDigest: string;
  /**
   * Present only when the statement marks at least one term, so a graph that
   * uses no vocabulary keeps every node file byte-identical. A separate field
   * rather than a fold into constraintsDigest because the repairs differ: stale
   * constraints mean "re-read your parent's claim", stale vocabulary means
   * "re-read the definition of a word you use".
   */
  vocabularyDigest?: string;
}

export interface MechanismImplementation {
  files: string[];
  digest: string;
}

export interface CanonicalNode {
  $schema?: string;
  schemaVersion?: 1;
  id: string;
  level: KnowledgeLevel;
  statement: string;
  constrainedBy: string[];
  sync?: NodeSyncState;
  implementation?: MechanismImplementation;
}

export interface TermSyncState {
  vocabularyDigest: string;
}

/**
 * A term is a name, not a claim: it has no constrainedBy, it neither promises
 * nor obeys, and it creates no frontier obligation. Its only edges are its
 * uses, which are derived from marked statement text and never authored.
 */
export interface TermNode {
  $schema?: string;
  schemaVersion?: 1;
  id: string;
  /**
   * Any level. Terms began at product on one argument — context describes the
   * member's world in the world's words, so a coined noun cannot appear in a
   * statement that stays true if you build nothing — but that argument is about
   * where a word may be SPOKEN, and PL1308 enforces exactly it. A second list
   * of permitted levels said the same thing worse: it refused a context level
   * the name for a thing that happens to the member, which survives the context
   * falsifier precisely because it is not a promise. PL0805 reports a term
   * declared where nothing at its level marks it, which is the same guard done
   * per graph instead of per tool.
   */
  level: KnowledgeLevel;
  /** The exact surface form as it appears in prose. Spaces and capitals allowed. */
  name: string;
  /** One sentence under STATEMENT_STYLE. May itself mark terms of its level or shallower. */
  definition: string;
  /** Present only when the definition marks at least one term. */
  sync?: TermSyncState;
}

export interface SourceTermNode extends TermNode {
  sourcePath: string;
}

/** Terms indexed for resolution. Names are unique case-insensitively. */
export interface Vocabulary {
  byId: Map<string, SourceTermNode>;
  byName: Map<string, SourceTermNode>;
}

export interface ReferenceEvidenceFile {
  path: string;
  lines?: [number, number];
}

export interface ReferenceNode {
  $schema?: string;
  schemaVersion?: 1;
  id: string;
  kind: string;
  statement: string;
  evidence?: {
    commit: string;
    files: ReferenceEvidenceFile[];
  };
  relatedNodes?: string[];
}

export interface GovernedPathConfig {
  include?: string[];
  exclude?: string[];
}

export interface CommitConventionConfig {
  trailer?: string;
  /** Trailer declaring a node deleted with its claim withdrawn. Default Knowledge-Removed. */
  removedTrailer?: string;
  /** Trailer declaring one claim restated: "<old-id> -> <new-id>". Default Knowledge-Renamed. */
  renamedTrailer?: string;
  requireBody?: boolean;
  /**
   * Optional JavaScript regular expression the commit subject must match.
   * Unset means the subject is unconstrained, which is the default: teams own
   * their own convention (Conventional Commits, Jira keys, anything else).
   */
  subjectPattern?: string;
}

export interface ProductLintConfig {
  $schema?: string;
  schemaVersion?: 1;
  root?: string;
  knowledgeRoot?: string;
  governedPaths?: GovernedPathConfig;
  commit?: CommitConventionConfig;
}

export interface ResolvedConfig {
  root: string;
  configPath: string;
  knowledgeRoot: string;
  canonicalRoots: Record<KnowledgeLevel, string>;
  referenceRoot: string;
  governedPaths: {
    include: string[];
    exclude: string[];
  };
  commit: {
    trailer: string;
    removedTrailer: string;
    renamedTrailer: string;
    requireBody: boolean;
    subjectPattern?: string;
  };
}

export interface SourceCanonicalNode extends CanonicalNode {
  sourcePath: string;
}

export interface SourceReferenceNode extends ReferenceNode {
  sourcePath: string;
}

export interface KnowledgeGraph {
  nodes: Map<string, SourceCanonicalNode>;
  parents: Map<string, Set<string>>;
  children: Map<string, Set<string>>;
  topologicalOrder: string[];
}

/**
 * One conjunct of an audience: for each set, either the named values or "*".
 * A missing set reads as "*", so a term never has to name a set to leave it
 * alone — which is what keeps a scope correct when that set gains a value.
 */
export type AudienceTerm = Record<string, Set<string> | "*">;

/**
 * A node's audience is a UNION of terms, not one term. Sets are closed under
 * intersection and not under union, and inheritance below Context is a union,
 * so the disjunction is the honest shape. The term count is bounded by a node's
 * distinct Context ancestors, never by the size of the product of the sets.
 */
export type Audience = AudienceTerm[];

export type DiagnosticSeverity = "error" | "warning" | "info";
export type DiagnosticAction = "ask-user" | "edit-node" | "run-command" | "inspect";

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  path?: string;
  nodeId?: string;
  frontier?: string;
  requiredLevel?: KnowledgeLevel | "implementation";
  action?: DiagnosticAction;
  infer?: boolean;
  question?: string;
  expectedPath?: string;
  command?: string;
  /** Specific repair for this diagnostic. Filled from the remediation table. */
  fix?: string;
  /** How to put the question to the user, present when the fix needs their answer. */
  ask?: string;
  /** Writing guidance, present when the fix asks for prose. */
  style?: string;
  /** How the node must sit beside its siblings, present when the fix adds one. */
  shape?: string;
  /** How the node must sit under its parent, present when the fix adds one below a node. */
  placement?: string;
  /** How defined terms are marked, coined, and placed, present when the fix writes prose that may use them. */
  vocabulary?: string;
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  graph?: KnowledgeGraph;
  references: SourceReferenceNode[];
  /** Declared terms, loaded from docs/<level>/terms/. Empty when none are declared. */
  terms: SourceTermNode[];
  diagnostics: Diagnostic[];
}

export interface FrontierResult {
  complete: boolean;
  diagnostics: Diagnostic[];
}

export interface FileKnowledgeResult {
  file: string;
  mechanisms: SourceCanonicalNode[];
  lineage: SourceCanonicalNode[];
  /** Resolved audience, absent when the graph defines no audience sets. */
  audience?: string;
  references: SourceReferenceNode[];
}

export interface AffectedKnowledgeResult {
  node: SourceCanonicalNode;
  descendants: SourceCanonicalNode[];
  mechanisms: SourceCanonicalNode[];
  files: string[];
  /** Resolved audience, absent when the graph defines no audience sets. */
  audience?: string;
  references: SourceReferenceNode[];
}

export type GitChangeStatus = "A" | "M" | "D" | "R" | "C" | "T" | "U" | "X" | "B";

export interface GitChange {
  status: GitChangeStatus;
  path: string;
  oldPath?: string;
}

export interface NodeChangeClassification {
  semantic: Set<string>;
  synchronizationOnly: Set<string>;
  added: Set<string>;
  deleted: Set<string>;
  changedPaths: Map<string, string>;
}

export interface SyncResult {
  updatedFiles: string[];
  unchangedFiles: string[];
  diagnostics: Diagnostic[];
}

export interface RenameDeclaration {
  from: string;
  to: string;
}

export interface RenamePair {
  deletedId: string;
  addedId: string;
  similarity: number;
  /** What convinced the matcher: the statement alone, or placement plus a shared word. */
  basis: "statement" | "parents";
}

export interface DeletionClassification {
  renames: RenamePair[];
  /** Deleted ids paired with nothing. Sorted. */
  removals: string[];
}

export interface CommitCheckResult {
  diagnostics: Diagnostic[];
  nodeChanges: NodeChangeClassification;
  changedImplementationFiles: GitChange[];
  /** How each staged deletion reads: a rename with a successor, or a removal. */
  deletions: DeletionClassification;
}

export interface CommitMessageResult {
  diagnostics: Diagnostic[];
  declared: Set<string>;
  removed: Set<string>;
  renamed: RenameDeclaration[];
  semantic: Set<string>;
}

export type SnapshotKind = "working" | "staged" | "head";

export interface RepositorySnapshot {
  kind: SnapshotKind;
  files: string[];
  readFile(path: string): Promise<string>;
  hasFile(path: string): boolean;
}
