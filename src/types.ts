export const KNOWLEDGE_LEVELS = [
  "context",
  "product",
  "behavior",
  "architecture",
  "mechanism",
] as const;

export type KnowledgeLevel = (typeof KNOWLEDGE_LEVELS)[number];

export interface NodeSyncState {
  constraintsDigest: string;
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
  attest?: AttestConfig;
}

/**
 * Which levels must carry a recorded review of each cohort.
 *
 * Unset means none, which is the default. The rule this enforces is not "these
 * nodes do not overlap" — no tool can decide that from prose — but "somebody
 * read these nodes together after the last time they changed."
 */
export interface AttestConfig {
  levels?: KnowledgeLevel[];
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
    requireBody: boolean;
    subjectPattern?: string;
  };
  attest: {
    levels: KnowledgeLevel[];
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
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  graph?: KnowledgeGraph;
  references: SourceReferenceNode[];
  diagnostics: Diagnostic[];
}

/**
 * The properties the graph is measured against, in dependency order.
 *
 * Kept few and kept decidable. Four scored candidates were built as far as
 * measurement and dropped, each against real graphs of 44 and 80 nodes:
 *
 *   correspondence between statement text and governed files — needs variation
 *     in the file-set distances to correlate against, and there is none. A
 *     branch that never re-merges gives siblings disjoint extents by tree shape
 *     alone; a graph with few Mechanism nodes gives them identical ones. Both
 *     shapes occur, and neither is measurable.
 *   vocabulary drift — two thirds of content terms appear at exactly one node,
 *     so "appears once" says nothing, and the near-matches are English.
 *   clause splitting — a coordinating conjunction appears in 76% to 84% of
 *     statements. The exact checks it was meant to extend survive; it did not.
 *   near-duplicate siblings — zero true positives and two false positives
 *     across 99 real sibling pairs, one of which was the approve/reject shape
 *     the rule is specifically supposed to allow.
 *
 * A band that cannot separate anything is not a band. Measure before adding one.
 */
export const BAND_NAMES = ["STRUCTURE", "COVERAGE", "OVERLAP"] as const;
export type BandName = (typeof BAND_NAMES)[number];

/** Why a band could not be measured. Never a number, so it can never read as zero. */
export type MaskReason = { band: BandName } | { rule: string };

export type BandState =
  | { kind: "clean" }
  | { kind: "measured"; residual: number }
  | { kind: "masked"; by: MaskReason };

export interface Band {
  name: BandName;
  title: string;
  state: BandState;
  /** Ranked evidence for the residual. Empty unless the band was measured. */
  findings: Diagnostic[];
}

export interface Spectrum {
  snapshot: SnapshotKind;
  /** Always BAND_NAMES.length entries, always in BAND_NAMES order. */
  bands: Band[];
}

export interface FrontierResult {
  complete: boolean;
  diagnostics: Diagnostic[];
}

export interface FileKnowledgeResult {
  file: string;
  mechanisms: SourceCanonicalNode[];
  lineage: SourceCanonicalNode[];
  references: SourceReferenceNode[];
}

export interface AffectedKnowledgeResult {
  node: SourceCanonicalNode;
  descendants: SourceCanonicalNode[];
  mechanisms: SourceCanonicalNode[];
  files: string[];
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

export interface CommitCheckResult {
  diagnostics: Diagnostic[];
  nodeChanges: NodeChangeClassification;
  changedImplementationFiles: GitChange[];
}

export interface CommitMessageResult {
  diagnostics: Diagnostic[];
  declared: Set<string>;
  semantic: Set<string>;
}

export type SnapshotKind = "working" | "staged" | "head";

export interface RepositorySnapshot {
  kind: SnapshotKind;
  files: string[];
  readFile(path: string): Promise<string>;
  hasFile(path: string): boolean;
}
