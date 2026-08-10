import path from "node:path";
import type {
  Diagnostic,
  KnowledgeGraph,
  RepositorySnapshot,
  ResolvedConfig,
} from "./types.js";
import type { Cohort } from "./extent.js";
import { cohortKey, cohortsOf } from "./extent.js";
import { semanticFingerprint } from "./graph.js";
import { digest } from "./stable-json.js";
import { normalizePath } from "./glob.js";

/**
 * Reviewing a level, recorded as a fact.
 *
 * Mutual exclusivity between two prose statements has no deterministic test, so
 * the tool does not attempt one. What it can decide is whether the judgement has
 * been made against the CURRENT text: digest the cohort, store the digest with
 * the review, and a later mismatch is arithmetic rather than opinion.
 *
 * This is the same move `sync.constraintsDigest` already makes for derived
 * state, applied to a judgement instead of a field. The tool never learns what
 * the reviewer concluded. It only ever knows whether they looked at this.
 */
export interface Attestation {
  $schema?: string;
  schemaVersion?: 1;
  cohort: string;
  digest: string;
  reviewedFor?: string[];
  /** The partition principle, in one sentence. Writing it is the review. */
  note: string;
}

export interface SourceAttestation extends Attestation {
  sourcePath: string;
}

/**
 * Over member ids and their semantic fingerprints, so the digest moves when a
 * member is added, removed, or restated, and stays put when a digest elsewhere
 * is resynchronized. Re-reviewing a level because an unrelated file changed is
 * how a review requirement becomes a rubber stamp.
 */
export function cohortDigest(graph: KnowledgeGraph, cohort: Cohort): string {
  const members = cohort.memberIds
    .map((id: string) => {
      const node = graph.nodes.get(id);
      return { id, fingerprint: node ? semanticFingerprint(node) : "missing" };
    })
    .sort((left: { id: string }, right: { id: string }) => (left.id < right.id ? -1 : 1));
  return digest({ cohort: cohortKey(cohort), members }, "product-lint-cohort-v1");
}

export function attestationRoot(config: ResolvedConfig): string {
  return path.join(config.knowledgeRoot, "attest");
}

/** Snapshot paths are repository-relative, so the prefix must be too. */
function attestationPrefix(config: ResolvedConfig): string {
  return `${normalizePath(path.relative(config.root, attestationRoot(config)))}/`;
}

export async function loadAttestations(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
): Promise<{ attestations: SourceAttestation[]; diagnostics: Diagnostic[] }> {
  const prefix = attestationPrefix(config);
  const attestations: SourceAttestation[] = [];
  const diagnostics: Diagnostic[] = [];
  const files = snapshot.files.filter(
    (file) => file.startsWith(prefix) && file.endsWith(".json"),
  );
  for (const file of files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await snapshot.readFile(file));
    } catch {
      diagnostics.push({
        code: "PL0801 INVALID_ATTESTATION",
        severity: "error",
        message: `${file} is not valid JSON.`,
        path: file,
      });
      continue;
    }
    const value = parsed as Partial<Attestation>;
    if (
      !value ||
      typeof value !== "object" ||
      typeof value.cohort !== "string" ||
      typeof value.digest !== "string" ||
      typeof value.note !== "string" ||
      value.note.trim().length === 0
    ) {
      diagnostics.push({
        code: "PL0801 INVALID_ATTESTATION",
        severity: "error",
        message: `${file} needs a cohort, a digest, and a non-empty note.`,
        path: file,
      });
      continue;
    }
    attestations.push({ ...(value as Attestation), sourcePath: file });
  }
  return { attestations, diagnostics };
}

/**
 * Cohorts of one are skipped. A single child cannot overlap a sibling it does
 * not have, and asking for a review of it would spend attention to learn
 * nothing — which is the fastest way to teach an agent to answer without reading.
 */
export function attestationDiagnostics(
  config: ResolvedConfig,
  graph: KnowledgeGraph,
  attestations: SourceAttestation[],
): Diagnostic[] {
  const levels = config.attest.levels;
  if (levels.length === 0) return [];

  const byCohort = new Map(attestations.map((item) => [item.cohort, item]));
  const diagnostics: Diagnostic[] = [];
  const live = new Set<string>();

  for (const cohort of cohortsOf(graph)) {
    if (!levels.includes(cohort.level)) continue;
    if (cohort.memberIds.length < 2) continue;
    const key = cohortKey(cohort);
    live.add(key);
    const expected = cohortDigest(graph, cohort);
    const recorded = byCohort.get(key);

    if (!recorded) {
      diagnostics.push({
        code: "PL0802 UNREVIEWED_COHORT",
        severity: "info",
        message: `${key} has ${cohort.memberIds.length} nodes and no recorded review.`,
        nodeId: cohort.parentId,
        requiredLevel: cohort.level,
        action: "edit-node",
        expectedPath: `${attestationPrefix(config)}*.json`,
        details: { cohort: key, members: cohort.memberIds, digest: expected },
      });
      continue;
    }
    if (recorded.digest !== expected) {
      diagnostics.push({
        code: "PL0803 STALE_COHORT_ATTESTATION",
        severity: "info",
        message: `${key} changed since it was reviewed.`,
        nodeId: cohort.parentId,
        path: recorded.sourcePath,
        requiredLevel: cohort.level,
        action: "edit-node",
        details: {
          cohort: key,
          members: cohort.memberIds,
          reviewedDigest: recorded.digest,
          currentDigest: expected,
        },
      });
    }
  }

  for (const item of attestations) {
    if (live.has(item.cohort)) continue;
    diagnostics.push({
      code: "PL0804 ORPHANED_ATTESTATION",
      severity: "info",
      message: `${item.cohort} no longer exists, so its review describes nothing.`,
      path: item.sourcePath,
      action: "edit-node",
      details: { cohort: item.cohort },
    });
  }

  return diagnostics;
}
