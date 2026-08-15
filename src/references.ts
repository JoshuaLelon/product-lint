import path from "node:path";
import type {
  Diagnostic,
  KnowledgeGraph,
  RepositorySnapshot,
  ResolvedConfig,
  SourceReferenceNode,
} from "./types.js";
import { normalizePath } from "./glob.js";
import { commitExists, fileExistsAtCommit } from "./git.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * PL1210: a reference no surface can reach.
 *
 * Everywhere else, storage that cannot be read is already refused. A term
 * nothing marks is PL0804, a term no statement at its level marks is PL0805, a
 * scope root naming no node is PL1401, an ignore naming an unknown smell is
 * PL1402. References were the one node type exempt: `relatedNodes` is optional,
 * PL1204 asks only for a kind and a statement, and a file with neither passes
 * every check and is then returned by nothing.
 *
 * Both readers match on `relatedNodes` — `knowledge for-file` and `affected-by`
 * intersect it with the node set, and `standingMistakeDiagnostics` filters to
 * references that have it. So a reference without it is not a weak record or a
 * badly written one. It is a file that validates, syncs, commits, and has no
 * path to a reader for the rest of the repository's life.
 *
 * An error rather than a warning, on PL1401's standard: the failure is silent
 * and total, and a warning saying "nothing will ever read this file" is read by
 * the same person who was not going to read the file.
 */
export function unreachableReferenceDiagnostics(
  references: SourceReferenceNode[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const reference of [...references].sort((left, right) => left.id.localeCompare(right.id))) {
    if ((reference.relatedNodes?.length ?? 0) === 0) {
      diagnostics.push({
        code: "PL1210 UNREACHABLE_REFERENCE",
        severity: "error",
        message: `${reference.id} names no relatedNodes, so no surface returns it: knowledge for-file and affected-by both match on relatedNodes, and a mistake without them never reaches PL0920.`,
        nodeId: reference.id,
        path: reference.sourcePath,
        action: "edit-node",
      });
      continue;
    }
    // A mistake is reported only while the node has not changed SINCE the
    // commit that recorded it, so without that commit there is nothing to
    // measure "since" against and the reference silently drops out.
    if (reference.kind === "mistake" && !reference.evidence?.commit) {
      diagnostics.push({
        code: "PL1210 UNREACHABLE_REFERENCE",
        severity: "error",
        message: `${reference.id} records a mistake with no evidence.commit, so PL0920 can never tell whether the claim changed since it was learned.`,
        nodeId: reference.id,
        path: reference.sourcePath,
        action: "edit-node",
      });
    }
  }
  return diagnostics;
}

export async function loadReferences(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
  graph?: KnowledgeGraph,
): Promise<{ references: SourceReferenceNode[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const references: SourceReferenceNode[] = [];
  const prefix = `${normalizePath(path.relative(config.root, config.referenceRoot))}/`;
  const files = snapshot.files.filter((file) => file.startsWith(prefix) && file.endsWith(".json"));
  const ids = new Set<string>();

  for (const file of files) {
    let input: unknown;
    try {
      input = JSON.parse(await snapshot.readFile(file)) as unknown;
    } catch (error) {
      diagnostics.push({
        code: "PL1200 INVALID_REFERENCE_JSON",
        severity: "error",
        message: `Invalid reference JSON: ${String(error)}`,
        path: file,
      });
      continue;
    }
    if (!isRecord(input)) {
      diagnostics.push({
        code: "PL1201 INVALID_REFERENCE",
        severity: "error",
        message: "Reference must be a JSON object.",
        path: file,
      });
      continue;
    }
    const id = typeof input.id === "string" ? input.id.trim() : "";
    const kind = typeof input.kind === "string" ? input.kind.trim() : "";
    const statement = typeof input.statement === "string" ? input.statement.trim() : "";
    if (!/^reference\.[a-z0-9][a-z0-9._-]*$/.test(id)) {
      diagnostics.push({
        code: "PL1202 INVALID_REFERENCE_ID",
        severity: "error",
        message: `Reference id must begin with reference.: ${id}`,
        path: file,
      });
      continue;
    }
    if (ids.has(id)) {
      diagnostics.push({
        code: "PL1203 DUPLICATE_REFERENCE_ID",
        severity: "error",
        message: `Duplicate reference id: ${id}`,
        path: file,
      });
      continue;
    }
    ids.add(id);
    if (!kind || !statement) {
      diagnostics.push({
        code: "PL1204 INCOMPLETE_REFERENCE",
        severity: "error",
        message: "Reference requires non-empty kind and statement.",
        path: file,
      });
      continue;
    }

    const relatedNodes = Array.isArray(input.relatedNodes)
      ? input.relatedNodes.filter((item): item is string => typeof item === "string")
      : [];
    for (const nodeId of relatedNodes) {
      if (graph && !graph.nodes.has(nodeId)) {
        diagnostics.push({
          code: "PL1205 MISSING_RELATED_NODE",
          severity: "error",
          message: `Reference ${id} names missing node ${nodeId}.`,
          path: file,
        });
      }
    }

    let evidence: SourceReferenceNode["evidence"];
    if (input.evidence !== undefined) {
      if (!isRecord(input.evidence) || typeof input.evidence.commit !== "string") {
        diagnostics.push({
          code: "PL1206 INVALID_REFERENCE_EVIDENCE",
          severity: "error",
          message: "Reference evidence requires commit and files.",
          path: file,
        });
        continue;
      }
      const commit = input.evidence.commit;
      const evidenceFiles = Array.isArray(input.evidence.files) ? input.evidence.files : [];
      const parsedFiles: { path: string; lines?: [number, number] }[] = [];
      for (const item of evidenceFiles) {
        if (!isRecord(item) || typeof item.path !== "string") {
          diagnostics.push({
            code: "PL1207 INVALID_REFERENCE_FILE",
            severity: "error",
            message: `Reference ${id} contains invalid evidence file metadata.`,
            path: file,
          });
          continue;
        }
        const lines = Array.isArray(item.lines) && item.lines.length === 2 && item.lines.every(Number.isInteger)
          ? ([item.lines[0], item.lines[1]] as [number, number])
          : undefined;
        parsedFiles.push({ path: normalizePath(item.path), ...(lines ? { lines } : {}) });
      }
      evidence = { commit, files: parsedFiles };

      if (!(await commitExists(config.root, commit))) {
        diagnostics.push({
          code: "PL1208 MISSING_REFERENCE_COMMIT",
          severity: "error",
          message: `Reference ${id} cites missing commit ${commit}.`,
          path: file,
        });
      } else {
        for (const evidenceFile of parsedFiles) {
          if (!(await fileExistsAtCommit(config.root, commit, evidenceFile.path))) {
            diagnostics.push({
              code: "PL1209 MISSING_REFERENCE_PATH",
              severity: "error",
              message: `Reference ${id} cites ${evidenceFile.path}, which does not exist at ${commit}.`,
              path: file,
            });
          }
        }
      }
    }

    references.push({
      ...(typeof input.$schema === "string" ? { $schema: input.$schema } : {}),
      schemaVersion: 1,
      id,
      kind,
      statement,
      ...(evidence ? { evidence } : {}),
      ...(relatedNodes.length > 0 ? { relatedNodes } : {}),
      sourcePath: file,
    });
  }

  diagnostics.push(...unreachableReferenceDiagnostics(references));

  return { references, diagnostics };
}
