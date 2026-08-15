import type {
  Diagnostic,
  SourceCanonicalNode,
  SourceTermNode,
  Vocabulary,
} from "./types.js";
import { buildVocabulary, levelIndex, resolveMark, resolveMarks, withoutMarks } from "./terms.js";

/**
 * The report half of vocabulary support: judgement calls, detected and put to
 * a human, never enforced. Everything here is severity info, in the spirit of
 * `contested` in `knowledge slice` — the tool names the pair and a person
 * decides. The decidable half (PL13xx, PL2004) lives with validation and sync.
 */

/**
 * Quoted spans are surface literals — the notation the statements already use
 * for what a screen displays verbatim — so a capitalized or matching word
 * inside them is not a candidate use of anything.
 */
function withoutQuoted(text: string): string {
  return text
    .replace(/"[^"\n]*"/g, " ")
    .replace(/(^|[\s([—-])'([^'\n]*)'(?=$|[\s).,;:!?—])/g, "$1 ");
}

export function tokenize(text: string): string[] {
  return [...text.matchAll(/[A-Za-z0-9][A-Za-z0-9']*/g)].map((match) => match[0].toLowerCase());
}

/**
 * Noun inflections only. "what was planned" and "planning surface" are verb
 * cousins and stay ordinary English; recall on an info-level report is the
 * right thing to trade for precision.
 */
function lastTokenVariants(token: string): Set<string> {
  const variants = new Set([token, `${token}'s`]);
  // -es only where English pluralizes with it, so "planes" never matches "plan".
  if (/(s|x|z|ch|sh)$/.test(token)) variants.add(`${token}es`);
  else variants.add(`${token}s`);
  return variants;
}

function containsSequence(tokens: string[], nameTokens: string[]): boolean {
  if (nameTokens.length === 0) return false;
  const variants = lastTokenVariants(nameTokens[nameTokens.length - 1]!);
  outer: for (let start = 0; start + nameTokens.length <= tokens.length; start += 1) {
    for (let offset = 0; offset < nameTokens.length - 1; offset += 1) {
      if (tokens[start + offset] !== nameTokens[offset]) continue outer;
    }
    if (variants.has(tokens[start + nameTokens.length - 1]!)) return true;
  }
  return false;
}

/**
 * PL0801, grouped by term rather than emitted per site — the way PL0602
 * renders a long file list as a tree — so a deliberately declared common word
 * folds into one block instead of drowning the rare findings.
 *
 * The scan never carries a dictionary: it looks only for declared names, only
 * at the term's level and deeper. A shallower occurrence is ordinary English
 * by construction — a statement above the term cannot mark it and stay valid
 * (PL1308), so the word there is not a missed mark but a different word.
 */
export function unmarkedUseDiagnostics(
  nodes: SourceCanonicalNode[],
  terms: SourceTermNode[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const term of [...terms].sort((left, right) => left.id.localeCompare(right.id))) {
    const nameTokens = tokenize(term.name);
    if (nameTokens.length === 0) continue;
    const uses: { id: string; statement: string }[] = [];
    for (const node of nodes) {
      if (levelIndex(node.level) < levelIndex(term.level)) continue;
      const visible = tokenize(withoutQuoted(withoutMarks(node.statement)));
      if (containsSequence(visible, nameTokens)) {
        uses.push({ id: node.id, statement: node.statement });
      }
    }
    if (uses.length === 0) continue;
    diagnostics.push({
      code: "PL0801 UNMARKED_TERM_USE",
      severity: "info",
      message: `"${term.name}" appears unmarked in ${uses.length} statement(s) at ${term.id}'s level or deeper.`,
      nodeId: term.id,
      path: term.sourcePath,
      action: "inspect",
      details: {
        term: { id: term.id, level: term.level, name: term.name, definition: term.definition },
        uses,
      },
    });
  }
  return diagnostics;
}

/**
 * PL0806: a name a term rejected as wrong, written unmarked in prose anyway.
 * The same scan as PL0801 pointed at the losers instead of the winner, and it
 * catches the drift the rejection was recorded to prevent — you decide a word
 * does not name the thing, then reach for it in a statement six months later.
 *
 * Only `wrong` rejections are scanned. A `taken` rejection says the word is
 * already load-bearing here, so its appearances in prose are the correct uses
 * it names — scanning them would report a term's own corpus back at it. In the
 * graph this was designed against, the two `taken` names accounted for ten
 * occurrences, every one legitimate; unfiltered, the first two terms declared
 * would have taught everyone to skip this report.
 */
export function rejectedNameUseDiagnostics(
  nodes: SourceCanonicalNode[],
  terms: SourceTermNode[],
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  for (const term of [...terms].sort((left, right) => left.id.localeCompare(right.id))) {
    for (const rejection of [...term.rejected].sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      if (rejection.stance !== "wrong") continue;
      const nameTokens = tokenize(rejection.name);
      if (nameTokens.length === 0) continue;
      const uses: { id: string; statement: string }[] = [];
      for (const node of nodes) {
        // The same level floor as PL0801: above the term, the word cannot be
        // this term's rejected word, because nothing up there could have
        // marked the term either.
        if (levelIndex(node.level) < levelIndex(term.level)) continue;
        const visible = tokenize(withoutQuoted(withoutMarks(node.statement)));
        if (containsSequence(visible, nameTokens)) {
          uses.push({ id: node.id, statement: node.statement });
        }
      }
      if (uses.length === 0) continue;
      diagnostics.push({
        code: "PL0806 REJECTED_NAME_IN_PROSE",
        severity: "info",
        message: `"${rejection.name}" was rejected as a name for *${term.name}* and appears in ${uses.length} statement(s) at ${term.level} or deeper.`,
        nodeId: term.id,
        path: term.sourcePath,
        action: "inspect",
        details: {
          term: { id: term.id, level: term.level, name: term.name, definition: term.definition },
          rejected: rejection.name,
          because: rejection.because,
          uses,
        },
      });
    }
  }
  return diagnostics;
}

/**
 * A determiner is a free noun detector. "the claim" is a noun in that sentence;
 * "reads" and "changed" never follow one. No part-of-speech tagger, no
 * dictionary, no model call — one pass, and the recall it gives up ("engineers
 * cannot find claims" contributes nothing) is the same trade PL0801 already
 * makes for the same reason.
 */
const DETERMINERS = new Set([
  "a", "an", "the", "every", "each", "its", "their", "this", "that", "no", "one", "two",
]);

/** The most-shared undeclared nouns shown at once. A display cap, like LEVEL_SAMPLE_LIMIT. */
const SHARED_NOUN_LIMIT = 5;
/** Uses printed per finding. You act on the word and its spread, not on the sentences. */
const SHARED_NOUN_USES = 3;

/**
 * PL0807: the nouns this graph keeps returning to that no term defines.
 *
 * The other reports here need something to already exist — a declared term for
 * PL0801, two for PL0802, a mid-sentence-capital habit for PL0803 — so a graph
 * written from scratch gets zero signal from all three, forever. "Zero declared
 * terms, zero noise" is the right property and it also means the feature never
 * starts.
 *
 * RANKED, NOT THRESHOLDED, and that is the whole design. A threshold asserts
 * "these ARE candidates", which is a judgement needing calibration against
 * graphs nobody has yet. A rank asserts "these are the most shared, look at
 * them", which needs none. The floor below is not a tuned number either: a word
 * in one statement at one level is not shared vocabulary under any reading.
 *
 * Breadth, not frequency. Frequency put "system" (29 uses, two levels) at the
 * top of the first draft of this and "module" and "implement" just under it —
 * one level each, boilerplate of the deepest layer. A word carrying meaning DOWN
 * the graph is what a term is.
 *
 * It does not find synonyms; a context-window test for those was tried against
 * a real corpus and returned noise. What it does is start the chain that finds
 * them: declare the word, and PL0801 hands you every unmarked use to read.
 * Reading those is where a second word for the same thing shows itself.
 *
 * SELF-QUIETING: a declared name leaves this report, so acting on a finding
 * removes it. That is the property PL0804 does not have, and the reason this one
 * is safe to print on a review surface.
 */
export function sharedNounDiagnostics(
  nodes: SourceCanonicalNode[],
  terms: SourceTermNode[],
): Diagnostic[] {
  const vocabulary = buildVocabulary(terms);
  const found = new Map<string, { levels: Set<string>; uses: { id: string; statement: string }[] }>();

  for (const node of nodes) {
    // A marked span is a declared-term use and PL0801's business; a quoted span
    // is a screen's own word.
    const words = tokenize(withoutQuoted(withoutMarks(node.statement)));
    const local = new Set<string>();
    for (let index = 1; index < words.length; index += 1) {
      const word = words[index]!;
      if (!DETERMINERS.has(words[index - 1]!)) continue;
      if (STOPWORDS.has(word) || word.length < 3) continue;
      // The same crude singularization markCandidates uses, so "claims" and
      // "claim" are one word here exactly as they are to a mark.
      local.add(word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word);
    }
    for (const word of local) {
      // A word a term already declares belongs to PL0801 when it is unmarked and
      // to nothing when it is marked. Three states, three reports, no overlap.
      if (resolveMark(word, vocabulary)) continue;
      const entry = found.get(word) ?? { levels: new Set<string>(), uses: [] };
      entry.levels.add(node.level);
      entry.uses.push({ id: node.id, statement: node.statement });
      found.set(word, entry);
    }
  }

  return [...found.entries()]
    // Shared at all, which is the definition rather than a threshold.
    .filter(([, entry]) => entry.levels.size >= 2 && entry.uses.length >= 2)
    .sort(
      ([leftWord, left], [rightWord, right]) =>
        right.levels.size - left.levels.size ||
        right.uses.length - left.uses.length ||
        leftWord.localeCompare(rightWord),
    )
    .slice(0, SHARED_NOUN_LIMIT)
    .map(([word, entry]) => ({
      code: "PL0807 SHARED_UNDECLARED_NOUN",
      severity: "info" as const,
      message: `"${word}" is used as a noun in ${entry.uses.length} statement(s) across ${entry.levels.size} level(s), and no term declares it.`,
      action: "inspect" as const,
      details: {
        word,
        levels: [...entry.levels],
        total: entry.uses.length,
        // Capped, unlike PL0801's list. There you must read each sentence to
        // choose between three readings; here you act on the word.
        uses: entry.uses.slice(0, SHARED_NOUN_USES),
      },
    }));
}

/**
 * Small and versioned on purpose: this list is part of the deterministic
 * contract, not a linguistics opinion. Changing it changes which pairs report,
 * so it changes only deliberately.
 */
const STOPWORDS = new Set([
  "a", "an", "and", "any", "are", "as", "at", "be", "by", "each", "every",
  "for", "in", "is", "it", "its", "never", "no", "not", "of", "on", "one",
  "only", "or", "so", "that", "the", "this", "to", "was", "what", "when",
  "which", "who", "with",
]);

export function contentTokens(definition: string): Set<string> {
  return new Set(tokenize(definition).filter((token) => !STOPWORDS.has(token)));
}

/**
 * PL0802: two definitions written in mostly the same words. This catches the
 * duplicate that was written by an author who never saw the level's terms; a
 * true synonym defined two different ways needs a reader, and the reader's
 * surface is this report's --json output — outside the lint path, never in it.
 */
export function synonymCandidateDiagnostics(terms: SourceTermNode[]): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...terms].sort((left, right) => left.id.localeCompare(right.id));
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      const one = sorted[left]!;
      const other = sorted[right]!;
      const oneTokens = contentTokens(one.definition);
      const otherTokens = contentTokens(other.definition);
      if (oneTokens.size < 4 || otherTokens.size < 4) continue;
      const shared = [...oneTokens].filter((token) => otherTokens.has(token)).length;
      const union = new Set([...oneTokens, ...otherTokens]).size;
      if (shared / union < 0.5) continue;
      diagnostics.push({
        code: "PL0802 SYNONYM_CANDIDATE",
        severity: "info",
        message: `${one.id} and ${other.id} have definitions that share most of their words. Two words may be one thing.`,
        nodeId: one.id,
        path: one.sourcePath,
        action: "inspect",
        details: {
          terms: [
            { id: one.id, name: one.name, definition: one.definition },
            { id: other.id, name: other.name, definition: other.definition },
          ],
        },
      });
    }
  }
  return diagnostics;
}

/**
 * PL0803, the migration seed. A mid-sentence capital is the convention the
 * statements were already half-using for product nouns; each one is either a
 * term waiting to be declared or a capital to lowercase. No dictionary: the
 * pattern excludes acronyms and sentence openers, and its false positives are
 * visible and ignorable at info severity.
 */
export function capitalizedUndeclaredDiagnostics(
  nodes: SourceCanonicalNode[],
  vocabulary: Vocabulary,
): Diagnostic[] {
  const found = new Map<string, { id: string; statement: string }[]>();
  for (const node of nodes) {
    const visible = withoutQuoted(withoutMarks(node.statement));
    for (const sentence of visible.split(/(?<=[.!?])\s+/)) {
      const words = [...sentence.matchAll(/[A-Za-z][A-Za-z']*/g)];
      const groups: string[][] = [];
      // End of the last word admitted to a group. A capital joins the open
      // group only when it follows it across a single space — "Won't Do" is
      // one candidate, "Do, Kind" is two.
      let lastGroupEnd = -2;
      for (let index = 1; index < words.length; index += 1) {
        const match = words[index]!;
        if (!/^[A-Z][a-z']+$/.test(match[0])) continue;
        const start = match.index!;
        if (groups.length > 0 && start === lastGroupEnd + 1 && sentence[lastGroupEnd] === " ") {
          groups[groups.length - 1]!.push(match[0]);
        } else {
          groups.push([match[0]]);
        }
        lastGroupEnd = start + match[0].length;
      }
      for (const group of groups) {
        const candidate = group.join(" ");
        // Resolution, not a bare name lookup, so "Kinds" is covered by a
        // declared "Kind" the same way a mark would be.
        if (resolveMark(candidate, vocabulary)) continue;
        const uses = found.get(candidate) ?? [];
        if (!uses.some((use) => use.id === node.id)) {
          uses.push({ id: node.id, statement: node.statement });
        }
        found.set(candidate, uses);
      }
    }
  }
  // "Kind" and "Kinds" are one candidate, not two: fold a plural onto its
  // singular when both were seen.
  for (const [word, uses] of [...found.entries()]) {
    const singular = word.endsWith("es") && found.has(word.slice(0, -2))
      ? word.slice(0, -2)
      : word.endsWith("s") && found.has(word.slice(0, -1))
        ? word.slice(0, -1)
        : undefined;
    if (!singular) continue;
    const target = found.get(singular)!;
    for (const use of uses) {
      if (!target.some((existing) => existing.id === use.id)) target.push(use);
    }
    found.delete(word);
  }
  return [...found.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([word, uses]) => ({
      code: "PL0803 CAPITALIZED_UNDECLARED",
      severity: "info" as const,
      message: `"${word}" is capitalized mid-sentence, which this graph reserves for defined terms, but no term declares it.`,
      action: "inspect" as const,
      details: { word, uses },
    }));
}

/** PL0804 and PL0805: declarations nothing marks, and declarations no statement at their own level marks. */
export function unusedTermDiagnostics(
  nodes: SourceCanonicalNode[],
  terms: SourceTermNode[],
  report: SourceTermNode[] = terms,
): Diagnostic[] {
  const vocabulary = buildVocabulary(terms);
  const statementLevels = new Map<string, Set<string>>();
  const usedAnywhere = new Set<string>();
  for (const node of nodes) {
    for (const term of resolveMarks(node.statement, vocabulary).terms) {
      usedAnywhere.add(term.id);
      const levels = statementLevels.get(term.id) ?? new Set<string>();
      levels.add(node.level);
      statementLevels.set(term.id, levels);
    }
  }
  for (const term of terms) {
    for (const marked of resolveMarks(term.definition, vocabulary).terms) {
      if (marked.id !== term.id) usedAnywhere.add(marked.id);
    }
  }

  const diagnostics: Diagnostic[] = [];
  for (const term of [...report].sort((left, right) => left.id.localeCompare(right.id))) {
    if (!usedAnywhere.has(term.id)) {
      diagnostics.push({
        code: "PL0804 UNUSED_TERM",
        severity: "info",
        message: `${term.id} is declared and nothing marks it.`,
        nodeId: term.id,
        path: term.sourcePath,
        action: "inspect",
      });
      continue;
    }
    const levels = statementLevels.get(term.id);
    if (levels && !levels.has(term.level)) {
      diagnostics.push({
        code: "PL0805 TERM_UNUSED_AT_ITS_LEVEL",
        severity: "info",
        message: `${term.id} is declared at ${term.level}, but no ${term.level} statement marks it.`,
        nodeId: term.id,
        path: term.sourcePath,
        action: "inspect",
      });
    }
  }
  return diagnostics;
}

export interface VocabularyReport {
  terms: SourceTermNode[];
  diagnostics: Diagnostic[];
}

export interface VocabularyReportOptions {
  /**
   * Paths changed in the staged diff. When present the report is scoped to
   * them: statements and terms outside the diff stay out, which is what keeps
   * the full report a periodic review rather than a checklist to zero.
   */
  changedPaths?: Set<string>;
}

export function vocabularyReport(
  nodes: SourceCanonicalNode[],
  terms: SourceTermNode[],
  options: VocabularyReportOptions = {},
): VocabularyReport {
  const changed = options.changedPaths;
  const vocabulary = buildVocabulary(terms);
  if (!changed) {
    return {
      terms,
      diagnostics: [
        ...unmarkedUseDiagnostics(nodes, terms),
        ...rejectedNameUseDiagnostics(nodes, terms),
        ...sharedNounDiagnostics(nodes, terms),
        ...synonymCandidateDiagnostics(terms),
        ...capitalizedUndeclaredDiagnostics(nodes, vocabulary),
        ...unusedTermDiagnostics(nodes, terms),
      ],
    };
  }

  const changedNodes = nodes.filter((node) => changed.has(node.sourcePath));
  const changedTerms = terms.filter((term) => changed.has(term.sourcePath));
  const unchangedTerms = terms.filter((term) => !changed.has(term.sourcePath));
  return {
    terms,
    diagnostics: [
      // A term declared or edited in this diff is read against every statement;
      // a term outside the diff is read only against the statements in it.
      ...unmarkedUseDiagnostics(nodes, changedTerms),
      ...unmarkedUseDiagnostics(changedNodes, unchangedTerms),
      ...rejectedNameUseDiagnostics(nodes, changedTerms),
      ...rejectedNameUseDiagnostics(changedNodes, unchangedTerms),
      // Scoped to the statements in the diff, like PL0801: the standing backlog
      // stays in the full report.
      ...sharedNounDiagnostics(changedNodes, terms),
      ...synonymCandidateDiagnostics(terms).filter((item) => {
        const pair = item.details?.terms as { id: string }[] | undefined;
        return pair?.some((entry) => changedTerms.some((term) => term.id === entry.id)) ?? false;
      }),
      ...capitalizedUndeclaredDiagnostics(changedNodes, vocabulary),
      ...unusedTermDiagnostics(nodes, terms, changedTerms),
    ],
  };
}

export interface TermAffectedResult {
  term: SourceTermNode;
  /** Canonical nodes whose statements mark the term. */
  nodes: SourceCanonicalNode[];
  /** Terms whose definitions mark the term. */
  terms: SourceTermNode[];
}

/** The blast radius of a definition change or a rename: every text that speaks the word. */
export function affectedByTerm(
  nodes: SourceCanonicalNode[],
  terms: SourceTermNode[],
  termId: string,
): TermAffectedResult {
  const vocabulary = buildVocabulary(terms);
  const term = vocabulary.byId.get(termId);
  if (!term) throw new Error(`Unknown term: ${termId}`);
  const markingNodes = nodes.filter((node) =>
    resolveMarks(node.statement, vocabulary).terms.some((item) => item.id === termId),
  );
  const markingTerms = terms.filter(
    (item) =>
      item.id !== termId &&
      resolveMarks(item.definition, vocabulary).terms.some((used) => used.id === termId),
  );
  return { term, nodes: markingNodes, terms: markingTerms };
}
