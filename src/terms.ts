import path from "node:path";
import type {
  Diagnostic,
  KnowledgeLevel,
  RepositorySnapshot,
  ResolvedConfig,
  SourceCanonicalNode,
  SourceTermNode,
  TermNode,
  TermRejection,
  Vocabulary,
} from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";
import { digest, stableStringify } from "./stable-json.js";
import { normalizePath } from "./glob.js";

const LEVEL_INDEX = new Map<KnowledgeLevel, number>(
  KNOWLEDGE_LEVELS.map((level, index) => [level, index]),
);

export function levelIndex(level: KnowledgeLevel): number {
  return LEVEL_INDEX.get(level)!;
}

const TERM_KEYS = new Set([
  "$schema",
  "schemaVersion",
  "id",
  "level",
  "name",
  "definition",
  "borrowed",
  "rejected",
  "sync",
]);

const REJECTION_KEYS = new Set(["name", "stance", "because"]);
const STANCES = new Set(["wrong", "taken"]);

/**
 * A use of a defined term is the term's name in single asterisks: *plan*.
 * A literal asterisk is escaped as \*. The parse is deterministic and total:
 * every asterisk either opens a mark, closes one, or is escaped, and anything
 * else is malformed rather than guessed at.
 */
export interface ParsedMarks {
  /** Mark contents, escapes resolved, in order of appearance. */
  marks: string[];
  /** The offending fragments: unbalanced, empty, or whitespace-edged marks. */
  malformed: string[];
}

export function parseMarks(text: string): ParsedMarks {
  const marks: string[] = [];
  const malformed: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && text[index + 1] === "*") {
      index += 2;
      continue;
    }
    if (text[index] !== "*") {
      index += 1;
      continue;
    }
    let end = -1;
    for (let scan = index + 1; scan < text.length; scan += 1) {
      if (text[scan] === "\\" && text[scan + 1] === "*") {
        scan += 1;
        continue;
      }
      if (text[scan] === "*") {
        end = scan;
        break;
      }
    }
    if (end === -1) {
      malformed.push(text.slice(index));
      break;
    }
    const content = text.slice(index + 1, end);
    if (content.length === 0 || content !== content.trim() || content.includes("\n")) {
      malformed.push(`*${content}*`);
    } else {
      marks.push(content.replaceAll("\\*", "*"));
    }
    index = end + 1;
  }
  return { marks, malformed };
}

/** The text with marked spans removed, for scans that must not double-count a marked use. */
export function withoutMarks(text: string): string {
  const output: string[] = [];
  let index = 0;
  while (index < text.length) {
    if (text[index] === "\\" && text[index + 1] === "*") {
      output.push("*");
      index += 2;
      continue;
    }
    if (text[index] !== "*") {
      output.push(text[index]!);
      index += 1;
      continue;
    }
    let end = -1;
    for (let scan = index + 1; scan < text.length; scan += 1) {
      if (text[scan] === "\\" && text[scan + 1] === "*") {
        scan += 1;
        continue;
      }
      if (text[scan] === "*") {
        end = scan;
        break;
      }
    }
    if (end === -1) break;
    output.push(" ");
    index = end + 1;
  }
  return output.join("");
}

function foldFirst(value: string): string {
  return value.length === 0 ? value : value[0]!.toLowerCase() + value.slice(1);
}

/**
 * The inflections a mark may carry outside the name: noun forms only. Verb
 * cousins of a noun term are almost always ordinary English, and a closed
 * suffix rule beats a stemmer the tool would then have to defend.
 */
function markCandidates(marked: string): string[] {
  const candidates = [marked];
  if (marked.endsWith("'s")) candidates.push(marked.slice(0, -2));
  // -es only where English pluralizes with it, so *planes* never reaches "plan".
  if (marked.endsWith("es") && /(s|x|z|ch|sh)$/.test(marked.slice(0, -2))) {
    candidates.push(marked.slice(0, -2));
  }
  if (marked.endsWith("s") && !marked.endsWith("'s")) candidates.push(marked.slice(0, -1));
  return candidates;
}

export function buildVocabulary(terms: SourceTermNode[]): Vocabulary {
  const byId = new Map<string, SourceTermNode>();
  const byName = new Map<string, SourceTermNode>();
  for (const term of terms) {
    if (!byId.has(term.id)) byId.set(term.id, term);
    const key = term.name.toLowerCase();
    if (!byName.has(key)) byName.set(key, term);
  }
  return { byId, byName };
}

/**
 * A mark resolves when it equals a declared name — case-sensitive except the
 * first character, so a term can open a sentence — allowing the noun
 * inflections s, es, and 's.
 */
export function resolveMark(marked: string, vocabulary: Vocabulary): SourceTermNode | undefined {
  for (const candidate of markCandidates(marked)) {
    const term = vocabulary.byName.get(candidate.toLowerCase());
    if (!term) continue;
    if (foldFirst(candidate) === foldFirst(term.name)) return term;
  }
  return undefined;
}

export interface ResolvedMarks {
  /** Distinct terms the text marks, in id order. */
  terms: SourceTermNode[];
  /** Marked text that resolves to no declaration. */
  unresolved: string[];
  malformed: string[];
}

export function resolveMarks(text: string, vocabulary: Vocabulary): ResolvedMarks {
  const parsed = parseMarks(text);
  const terms = new Map<string, SourceTermNode>();
  const unresolved: string[] = [];
  for (const mark of parsed.marks) {
    const term = resolveMark(mark, vocabulary);
    if (term) terms.set(term.id, term);
    else unresolved.push(mark);
  }
  return {
    terms: [...terms.values()].sort((left, right) => left.id.localeCompare(right.id)),
    unresolved,
    malformed: parsed.malformed,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseTermNode(
  value: unknown,
  sourcePath: string,
  folderLevel: KnowledgeLevel,
): { node?: SourceTermNode; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (!isRecord(value)) {
    return {
      diagnostics: [
        {
          code: "PL1301 INVALID_TERM",
          severity: "error",
          message: "Term node must be a JSON object.",
          path: sourcePath,
        },
      ],
    };
  }

  for (const key of Object.keys(value)) {
    if (!TERM_KEYS.has(key)) {
      diagnostics.push({
        code: "PL1301 INVALID_TERM",
        severity: "error",
        message: `Unknown term field: ${key}`,
        path: sourcePath,
      });
    }
  }

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const level = typeof value.level === "string" ? value.level : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const definition = typeof value.definition === "string" ? value.definition.trim() : "";

  if (!id || !/^term\.[a-z0-9][a-z0-9._-]*$/.test(id)) {
    diagnostics.push({
      code: "PL1302 INVALID_TERM_ID",
      severity: "error",
      message: id
        ? `Term id must be "term." followed by lowercase semantic identifiers: ${id}`
        : "Term node is missing a non-empty id.",
      path: sourcePath,
      ...(id ? { nodeId: id } : {}),
    });
  }

  if (!KNOWLEDGE_LEVELS.includes(level as KnowledgeLevel)) {
    diagnostics.push({
      code: "PL1301 INVALID_TERM",
      severity: "error",
      message: `Invalid term level: ${String(value.level)}. A term is declared at ${KNOWLEDGE_LEVELS.join(", ")}.`,
      path: sourcePath,
      nodeId: id || undefined,
    });
  } else if (level !== folderLevel) {
    diagnostics.push({
      code: "PL1306 TERM_FOLDER_MISMATCH",
      severity: "error",
      message: `Term declares level ${level} but is stored under ${folderLevel}.`,
      path: sourcePath,
      nodeId: id || undefined,
    });
  }

  if (!name || !definition) {
    diagnostics.push({
      code: "PL1305 MISSING_TERM_DEFINITION",
      severity: "error",
      message: `Term node is missing a non-empty ${!name ? "name" : "definition"}.`,
      path: sourcePath,
      nodeId: id || undefined,
    });
  }
  if (name.includes("*") || name.includes("\n")) {
    diagnostics.push({
      code: "PL1301 INVALID_TERM",
      severity: "error",
      message: "A term name is prose: no asterisks and no line breaks.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  }

  let borrowed: string | undefined;
  if (value.borrowed !== undefined) {
    const text = typeof value.borrowed === "string" ? value.borrowed.trim() : "";
    if (!text) {
      diagnostics.push({
        code: "PL1301 INVALID_TERM",
        severity: "error",
        message: "borrowed is a non-empty sentence, or it is absent. Nothing is not an origin.",
        path: sourcePath,
        nodeId: id || undefined,
      });
    } else {
      borrowed = text;
    }
  }

  // Required with an empty array legal, so [] means "nothing was weighed" and
  // never "nobody wrote it down". The two states are the whole reason the
  // field can be trusted, and an optional field cannot tell them apart.
  const rejected: TermRejection[] = [];
  if (!Array.isArray(value.rejected)) {
    diagnostics.push({
      code: "PL1301 INVALID_TERM",
      severity: "error",
      message:
        value.rejected === undefined
          ? 'Term node is missing "rejected". Record the names you weighed and passed on, or "rejected": [] to say nothing was weighed.'
          : "rejected must be an array.",
      path: sourcePath,
      nodeId: id || undefined,
    });
  } else {
    const seen = new Set<string>();
    for (const entry of value.rejected) {
      if (!isRecord(entry)) {
        diagnostics.push({
          code: "PL1301 INVALID_TERM",
          severity: "error",
          message: "Each rejection is an object with name, stance, and because.",
          path: sourcePath,
          nodeId: id || undefined,
        });
        continue;
      }
      for (const key of Object.keys(entry)) {
        if (!REJECTION_KEYS.has(key)) {
          diagnostics.push({
            code: "PL1301 INVALID_TERM",
            severity: "error",
            message: `Unknown rejection field: ${key}`,
            path: sourcePath,
            nodeId: id || undefined,
          });
        }
      }
      const rejectedName = typeof entry.name === "string" ? entry.name.trim() : "";
      const stance = typeof entry.stance === "string" ? entry.stance : "";
      const because = typeof entry.because === "string" ? entry.because.trim() : "";
      if (!rejectedName || !because) {
        diagnostics.push({
          code: "PL1301 INVALID_TERM",
          severity: "error",
          message: `A rejection carries a non-empty ${!rejectedName ? "name" : "because"}. A bare list of names is a suppression list, not a decision.`,
          path: sourcePath,
          nodeId: id || undefined,
        });
        continue;
      }
      if (!STANCES.has(stance)) {
        diagnostics.push({
          code: "PL1301 INVALID_TERM",
          severity: "error",
          message: `Invalid rejection stance for "${rejectedName}": ${String(entry.stance)}. Use wrong when the word does not name this thing, taken when it already names something else here.`,
          path: sourcePath,
          nodeId: id || undefined,
        });
        continue;
      }
      // A term that rejects its own name says nothing, and would report
      // against itself forever.
      if (name && rejectedName.toLowerCase() === name.toLowerCase()) {
        diagnostics.push({
          code: "PL1301 INVALID_TERM",
          severity: "error",
          message: `A term cannot reject its own name: "${rejectedName}".`,
          path: sourcePath,
          nodeId: id || undefined,
        });
        continue;
      }
      if (seen.has(rejectedName.toLowerCase())) {
        diagnostics.push({
          code: "PL1301 INVALID_TERM",
          severity: "error",
          message: `"${rejectedName}" is rejected twice by the same term. One name, one reason.`,
          path: sourcePath,
          nodeId: id || undefined,
        });
        continue;
      }
      seen.add(rejectedName.toLowerCase());
      rejected.push({ name: rejectedName, stance: stance as TermRejection["stance"], because });
    }
  }

  let sync: TermNode["sync"];
  if (value.sync !== undefined) {
    if (!isRecord(value.sync) || typeof value.sync.vocabularyDigest !== "string") {
      diagnostics.push({
        code: "PL1301 INVALID_TERM",
        severity: "error",
        message: "sync must contain a string vocabularyDigest.",
        path: sourcePath,
        nodeId: id || undefined,
      });
    } else {
      sync = { vocabularyDigest: value.sync.vocabularyDigest };
    }
  }

  if (diagnostics.some((item) => item.severity === "error")) return { diagnostics };

  return {
    node: {
      ...(typeof value.$schema === "string" ? { $schema: value.$schema } : {}),
      ...(value.schemaVersion === 1 ? { schemaVersion: 1 as const } : {}),
      id,
      level: level as KnowledgeLevel,
      name,
      definition,
      ...(borrowed ? { borrowed } : {}),
      rejected,
      ...(sync ? { sync } : {}),
      sourcePath,
    },
    diagnostics,
  };
}

/**
 * Term files live inside the level that declares them: docs/<level>/terms/.
 * The folder is what answers the "central glossary" objection — the term is
 * declared in the level that needs it, and the level is validated against the
 * field the way node folders already are.
 */
export function termRootFor(config: ResolvedConfig, level: KnowledgeLevel): string {
  return normalizePath(path.relative(config.root, path.join(config.canonicalRoots[level], "terms")));
}

export async function loadTermNodes(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
): Promise<{ terms: SourceTermNode[]; diagnostics: Diagnostic[] }> {
  const diagnostics: Diagnostic[] = [];
  const terms: SourceTermNode[] = [];

  for (const level of KNOWLEDGE_LEVELS) {
    const prefix = `${termRootFor(config, level)}/`;
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
      const result = parseTermNode(parsed, file, level);
      diagnostics.push(...result.diagnostics);
      if (result.node) terms.push(result.node);
    }
  }

  // One term, one declaration — by id, and by surface form. The name check is
  // case-insensitive across the whole name and across levels, because a reader
  // of any statement resolves *plan* without knowing what level they are on.
  const byId = new Map<string, SourceTermNode>();
  const byName = new Map<string, SourceTermNode>();
  const unique: SourceTermNode[] = [];
  for (const term of terms) {
    const existingId = byId.get(term.id);
    if (existingId) {
      diagnostics.push({
        code: "PL1303 DUPLICATE_TERM_ID",
        severity: "error",
        message: `Duplicate term id appears in ${existingId.sourcePath} and ${term.sourcePath}.`,
        nodeId: term.id,
        path: term.sourcePath,
      });
      continue;
    }
    byId.set(term.id, term);
    const existingName = byName.get(term.name.toLowerCase());
    if (existingName) {
      diagnostics.push({
        code: "PL1304 DUPLICATE_TERM_NAME",
        severity: "error",
        message: `${existingName.id} and ${term.id} both name "${term.name}". One name has one thing.`,
        nodeId: term.id,
        path: term.sourcePath,
        details: {
          terms: [existingName.id, term.id],
          name: term.name,
        },
      });
      continue;
    }
    byName.set(term.name.toLowerCase(), term);
    unique.push(term);
  }

  diagnostics.push(...rejectedNameDiagnostics(unique));

  return { terms: unique, diagnostics };
}

/**
 * PL1312: a declared name that another term weighed and rejected as wrong.
 *
 * What it asserts is not "this is a duplicate" — nothing can tell a duplicate
 * wearing the rejected name from a real second sense. It asserts that a
 * recorded decision is being contradicted without saying so, and every repair
 * leaves a trace: a two-word name, or a deleted rejection that is itself the
 * record of the reversal.
 *
 * Global and case-insensitive on the whole name, matching PL1304 exactly,
 * because marks resolve globally — a reader of any statement resolves *plan*
 * without knowing what level they are on, so a level-scoped rejection would
 * be incoherent with the notation.
 *
 * A second pass over the deduplicated list rather than a check inside the load
 * loop, so the finding does not depend on which file was read first.
 *
 * `taken` rejections are skipped. That stance says the word already names
 * something else here, so the thing being declared is what the rejection
 * PREDICTED, not a contradiction of it; reporting it would fire on the case it
 * was written to describe, and the only clean repair would be deleting a true
 * record.
 */
export function rejectedNameDiagnostics(terms: SourceTermNode[]): Diagnostic[] {
  const sorted = [...terms].sort((left, right) => left.id.localeCompare(right.id));
  const declared = new Map<string, SourceTermNode>();
  for (const term of sorted) {
    if (!declared.has(term.name.toLowerCase())) declared.set(term.name.toLowerCase(), term);
  }
  const diagnostics: Diagnostic[] = [];
  for (const term of sorted) {
    for (const rejection of term.rejected) {
      if (rejection.stance !== "wrong") continue;
      const collides = declared.get(rejection.name.toLowerCase());
      if (!collides || collides.id === term.id) continue;
      diagnostics.push({
        code: "PL1312 REJECTED_TERM_NAME",
        severity: "error",
        message: `${collides.id} names "${collides.name}", which ${term.id} rejected: ${rejection.because}`,
        nodeId: collides.id,
        path: collides.sourcePath,
        action: "edit-node",
        details: {
          declared: { id: collides.id, name: collides.name, level: collides.level },
          rejectedBy: { id: term.id, name: term.name, level: term.level },
          because: rejection.because,
        },
      });
    }
  }
  return diagnostics;
}

function markDiagnostics(
  text: string,
  vocabulary: Vocabulary,
  site: { level: KnowledgeLevel; id: string; sourcePath: string },
  field: "statement" | "definition",
): { terms: SourceTermNode[]; diagnostics: Diagnostic[] } {
  const resolved = resolveMarks(text, vocabulary);
  const diagnostics: Diagnostic[] = [];
  for (const fragment of resolved.malformed) {
    diagnostics.push({
      code: "PL1311 MALFORMED_TERM_MARK",
      severity: "error",
      message: `${site.id} has an unbalanced or empty term mark in its ${field}: ${fragment}`,
      nodeId: site.id,
      path: site.sourcePath,
      action: "edit-node",
    });
  }
  for (const mark of resolved.unresolved) {
    diagnostics.push({
      code: "PL1307 MISSING_TERM",
      severity: "error",
      message: `${field === "statement" ? "Statement" : "Definition"} marks *${mark}* but no term declares it.`,
      nodeId: site.id,
      path: site.sourcePath,
      action: "edit-node",
      details: { mark },
    });
  }
  for (const term of resolved.terms) {
    // Vocabulary flows the way knowledge does: down only. A statement may use
    // terms of its own level and above; a definition, of its own level and
    // above. This is the whole of the rule now that every level may declare:
    // widening where a name may be COINED left where it may be SPOKEN exactly
    // as it was, so a product term marked in a context statement is still an
    // error — reachable now rather than impossible, and still refused.
    if (levelIndex(term.level) > levelIndex(site.level)) {
      diagnostics.push({
        code: "PL1308 TERM_FROM_BELOW",
        severity: "error",
        message: `${site.id} marks *${term.name}*, which is declared at ${term.level}. A ${field} uses vocabulary from its own level and above, never below.`,
        nodeId: site.id,
        path: site.sourcePath,
        action: "edit-node",
        details: { term: term.id, termLevel: term.level, siteLevel: site.level },
      });
    }
  }
  return { terms: resolved.terms, diagnostics };
}

/** PL1307/PL1308/PL1311 for every canonical statement. */
export function statementMarkDiagnostics(
  nodes: SourceCanonicalNode[],
  vocabulary: Vocabulary,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const node of nodes) {
    diagnostics.push(...markDiagnostics(node.statement, vocabulary, node, "statement").diagnostics);
  }
  return diagnostics;
}

/** The same checks for definitions, plus the cycle check definitions make possible. */
export function definitionMarkDiagnostics(
  terms: SourceTermNode[],
  vocabulary: Vocabulary,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const edges = new Map<string, string[]>();
  for (const term of terms) {
    const result = markDiagnostics(term.definition, vocabulary, term, "definition");
    diagnostics.push(...result.diagnostics);
    edges.set(
      term.id,
      result.terms.map((item) => item.id).filter((id) => id !== term.id),
    );
  }

  // Two definitions that need each other define neither. Same standard as
  // PL1105: the cycle is named, and the repair is to remove one edge.
  const state = new Map<string, "visiting" | "done">();
  const cycles: string[][] = [];
  const walk = (id: string, trail: string[]): void => {
    const seen = state.get(id);
    if (seen === "done") return;
    if (seen === "visiting") {
      cycles.push(trail.slice(trail.indexOf(id)));
      return;
    }
    state.set(id, "visiting");
    for (const next of edges.get(id) ?? []) walk(next, [...trail, next]);
    state.set(id, "done");
  };
  for (const id of [...edges.keys()].sort()) walk(id, [id]);
  for (const cycle of cycles) {
    diagnostics.push({
      code: "PL1310 TERM_CYCLE",
      severity: "error",
      message: `Term definitions mark each other in a cycle: ${cycle.join(" -> ")}`,
      nodeId: cycle[0],
      path: vocabulary.byId.get(cycle[0]!)?.sourcePath,
      details: { cycle },
    });
  }
  return diagnostics;
}

/**
 * The meaning of a term: what a rename, a move, or a rewrite changes.
 *
 * `borrowed` and `rejected` are deliberately outside it. Discovering that your
 * word matches an established one does not change what any statement means,
 * and neither does writing down a name you passed on — so neither restates the
 * statements that speak the word. Editing the DEFINITION to match a borrowed
 * sense does change meaning, and that still propagates. Without this line, a
 * pass attaching origins to an existing vocabulary would restate the whole
 * graph for no change in meaning, and would simply not get done.
 */
export function semanticTermFingerprint(term: TermNode): string {
  return digest(
    { id: term.id, level: term.level, name: term.name, definition: term.definition },
    "product-lint-term-v1",
  );
}

export function termFingerprint(term: TermNode): string {
  return digest(
    {
      id: term.id,
      level: term.level,
      name: term.name,
      definition: term.definition,
      borrowed: term.borrowed ?? null,
      rejected: term.rejected,
      sync: term.sync ?? null,
    },
    "product-lint-term-node-v1",
  );
}

/**
 * The digest a marking node carries: the sorted (id, meaning) pairs of the
 * terms its text marks. Changing a definition therefore invalidates every
 * statement that speaks the word, exactly as a parent change does.
 */
export function vocabularyDigest(termsUsed: SourceTermNode[]): string {
  const pairs = termsUsed
    .map((term) => ({ id: term.id, fingerprint: semanticTermFingerprint(term) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return digest(pairs, "product-lint-vocabulary-v1");
}

export interface RecordedRejection {
  /** The term as it should be written, absent when the rejection is refused. */
  term?: SourceTermNode;
  diagnostics: Diagnostic[];
}

/**
 * The write behind `term reject`.
 *
 * Required `rejected` reaches exactly one moment, the term's creation, and the
 * alternatives to a name are usually weighed later — while writing a statement,
 * about a term declared months ago and not currently open. Recording one then
 * costs finding the file and matching an array shape, which is more than the
 * decision cost, so it does not happen and the alternative is gone by lunch.
 *
 * Refusals reuse the codes the write would have caused rather than inventing a
 * command-time family, so the message here is the message `validate` would give.
 * Refusing beats writing a file already known to fail.
 */
export function recordRejection(
  terms: SourceTermNode[],
  termId: string,
  rejection: TermRejection,
): RecordedRejection {
  const vocabulary = buildVocabulary(terms);
  const term = vocabulary.byId.get(termId);
  if (!term) throw new Error(`Unknown term: ${termId}`);

  const name = rejection.name.trim();
  const because = rejection.because.trim();
  const refuse = (code: string, message: string): RecordedRejection => ({
    diagnostics: [
      { code, severity: "error", message, nodeId: term.id, path: term.sourcePath, action: "edit-node" },
    ],
  });

  if (!name || !because) {
    return refuse(
      "PL1301 INVALID_TERM",
      `A rejection carries a non-empty ${!name ? "name" : "because"}. A bare list of names is a suppression list, not a decision.`,
    );
  }
  if (name.toLowerCase() === term.name.toLowerCase()) {
    return refuse("PL1301 INVALID_TERM", `A term cannot reject its own name: "${name}".`);
  }
  if (term.rejected.some((item) => item.name.toLowerCase() === name.toLowerCase())) {
    return refuse(
      "PL1301 INVALID_TERM",
      `${term.id} already rejected "${name}". One name, one reason — edit the existing entry to change it.`,
    );
  }
  // The collision named before the file changes, not one second later. A word
  // that is already a declared name is spoken for rather than wrong, and the
  // stance that says so is the repair.
  if (rejection.stance === "wrong") {
    const declared = vocabulary.byName.get(name.toLowerCase());
    if (declared) {
      return refuse(
        "PL1312 REJECTED_TERM_NAME",
        `${declared.id} already names "${declared.name}", so rejecting it as wrong for ${term.id} would refuse a declaration that exists. If the word is spoken for rather than wrong, record it with the taken stance instead.`,
      );
    }
  }

  return {
    term: { ...term, rejected: [...term.rejected, { name, stance: rejection.stance, because }] },
    diagnostics: [],
  };
}

export function serializeTermNode(term: SourceTermNode): string {
  const output: TermNode = {
    ...(term.$schema ? { $schema: term.$schema } : {}),
    schemaVersion: 1,
    id: term.id,
    level: term.level,
    name: term.name,
    definition: term.definition,
    ...(term.borrowed ? { borrowed: term.borrowed } : {}),
    rejected: term.rejected,
    ...(term.sync ? { sync: term.sync } : {}),
  };
  return `${stableStringify(output, 2)}\n`;
}
