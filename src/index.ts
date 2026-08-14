export { loadConfig } from "./config.js";
export { validateSnapshot } from "./validation.js";
export { buildKnowledgeGraph, loadCanonicalNodes, ancestorsOf, descendantsOf } from "./graph.js";
export { detectFrontier, filesForMechanism, governedFiles } from "./frontier.js";
export { knowledgeForFile, affectedByNode, sliceForAudience } from "./queries.js";
export {
  audienceSets,
  audienceSetFingerprint,
  audienceContains,
  audienceMatches,
  audienceOverlaps,
  formatAudience,
  simplifyAudience,
  isAudienceWildcard,
  parseSelector,
  resolveAudiences,
} from "./audience.js";
export {
  synchronizeStaged,
  expectedSynchronizedNodes,
  expectedSynchronizedTerms,
  synchronizationDiagnostics,
} from "./sync.js";
export { checkStagedCommit, checkCommitMessage, classifyNodeChanges, classifyTermChanges } from "./commit.js";
export { classifyDeletions, deletionDiagnostics } from "./removal.js";
export {
  buildVocabulary,
  loadTermNodes,
  parseMarks,
  resolveMark,
  resolveMarks,
  semanticTermFingerprint,
  serializeTermNode,
  statementMarkDiagnostics,
  definitionMarkDiagnostics,
  termFingerprint,
  vocabularyDigest,
  withoutMarks,
} from "./terms.js";
export {
  affectedByTerm,
  capitalizedUndeclaredDiagnostics,
  synonymCandidateDiagnostics,
  unmarkedUseDiagnostics,
  unusedTermDiagnostics,
  vocabularyReport,
} from "./vocabulary.js";
export { inspectWorkingTree } from "./status.js";
export { renderFileKnowledgeForLlm, renderAffectedKnowledgeForLlm } from "./llms.js";
export { createSnapshot } from "./repository.js";
export { initProject } from "./init.js";
export { formatDiagnostic, formatDiagnostics, hasErrors } from "./diagnostics.js";
export {
  annotateDiagnostic,
  annotateDiagnostics,
  ASK_FORMATS,
  STATEMENT_STYLE,
  NODE_SHAPE,
  AUDIENCE_SHAPE,
  LEVEL_PLACEMENT,
  VOCABULARY_RULE,
} from "./remediation.js";
export { KNOWLEDGE_LEVELS, TERM_LEVELS } from "./types.js";
export type * from "./types.js";
