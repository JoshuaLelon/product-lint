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
  details?: Record<string, unknown>;
}

export interface ValidationResult {
  graph?: KnowledgeGraph;
  references: SourceReferenceNode[];
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
