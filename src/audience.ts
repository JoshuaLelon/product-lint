import type { Audience, AudienceTerm, KnowledgeGraph, SourceCanonicalNode } from "./types.js";
import { digest } from "./stable-json.js";

/**
 * The audience level is not one set of nodes. It is n sets, each a partition of
 * the people who use the product, and an audience is a point in their product.
 * The set a value belongs to is the second segment of its id:
 *
 *   audience.<set>.<value>      audience.role.admin
 *   audience.<set>.*            every value of that set, including later ones
 *
 * A Context names a SELECTOR over those sets: values within one set are read as
 * OR, and sets are read as AND. A set the Context does not name is unconstrained.
 * That is what lets "enterprise, any role" cost one parent instead of one per
 * combination, and what makes a conjunction expressible at all — two parents
 * from two different sets mean "both", which no flat list of values can say.
 */

export function isAudienceWildcard(id: string): boolean {
  return /^audience\.[a-z0-9][a-z0-9_-]*\.\*$/.test(id);
}

/** The set an audience id belongs to, wildcard or not. */
export function audienceAxis(id: string): string | undefined {
  const match = /^audience\.([a-z0-9][a-z0-9_-]*)\./.exec(id);
  return match?.[1];
}

export function audienceValue(id: string): string | undefined {
  const match = /^audience\.[a-z0-9][a-z0-9_-]*\.(.+)$/.exec(id);
  return match?.[1] === "*" ? undefined : match?.[1];
}

export function audienceSetMembers(
  nodes: Iterable<SourceCanonicalNode>,
  axis: string,
): string[] {
  const values: string[] = [];
  for (const node of nodes) {
    if (node.level !== "audience") continue;
    if (audienceAxis(node.id) !== axis) continue;
    const value = audienceValue(node.id);
    if (value !== undefined) values.push(value);
  }
  return values.sort();
}

/** Every audience set in the graph, set name to sorted values. */
export function audienceSets(graph: KnowledgeGraph): Map<string, string[]> {
  const sets = new Map<string, string[]>();
  for (const node of graph.nodes.values()) {
    if (node.level !== "audience") continue;
    const axis = audienceAxis(node.id);
    const value = audienceValue(node.id);
    if (!axis || value === undefined) continue;
    const values = sets.get(axis) ?? [];
    values.push(value);
    sets.set(axis, values);
  }
  for (const [axis, values] of sets) sets.set(axis, values.sort());
  return sets;
}

/**
 * The fingerprint a wildcard parent carries. It is the SET MEMBERSHIP, so that
 * adding a value to the set changes it, and every node scoped by the wildcard
 * goes stale. This is the whole reason the wildcard exists: the digest can only
 * watch what a node names, and a node that enumerated the values would name
 * nothing that changed when a value was added beside them.
 */
export function audienceSetFingerprint(graph: KnowledgeGraph, axis: string): string {
  return digest(audienceSets(graph).get(axis) ?? [], "product-lint-audience-set-v1");
}

/** The wildcard ids a node names, sorted. */
export function wildcardParents(node: SourceCanonicalNode): string[] {
  return node.constrainedBy.filter(isAudienceWildcard).sort();
}

function everySet(sets: Map<string, string[]>): AudienceTerm {
  const term: AudienceTerm = {};
  for (const axis of sets.keys()) term[axis] = "*";
  return term;
}

/** The selector a node's own audience parents describe. Unnamed set is "*". */
export function selectorOf(
  node: SourceCanonicalNode,
  sets: Map<string, string[]>,
): AudienceTerm {
  const term = everySet(sets);
  for (const parentId of node.constrainedBy) {
    const axis = audienceAxis(parentId);
    if (!axis || !sets.has(axis)) continue;
    if (isAudienceWildcard(parentId)) {
      term[axis] = "*";
      continue;
    }
    const value = audienceValue(parentId);
    if (value === undefined) continue;
    const current = term[axis];
    if (current === undefined || current === "*") term[axis] = new Set([value]);
    else current.add(value);
  }
  return term;
}

export function termKey(term: AudienceTerm, axes: string[]): string {
  return axes
    .map((axis) => {
      const value = term[axis];
      return value === undefined || value === "*" ? "*" : [...value].sort().join("+");
    })
    .join("|");
}

/**
 * Resolve every node's audience, bottom-up in topological order.
 *
 * An audience node is its own value. A Context is its selector. Everything
 * below is the UNION of its parents, because the edge means "justified by": a
 * node justified by a rule that serves everyone is needed by everyone, and a
 * second justification cannot retract the first. So audience below Context is
 * derived and never declared, which is why no node can claim a scope its
 * ancestry does not give it.
 */
export function resolveAudiences(graph: KnowledgeGraph): Map<string, Audience> {
  const sets = audienceSets(graph);
  const axes = [...sets.keys()].sort();
  const resolved = new Map<string, Audience>();

  for (const id of graph.topologicalOrder) {
    const node = graph.nodes.get(id)!;
    if (node.level === "audience") {
      const axis = audienceAxis(id);
      const value = audienceValue(id);
      const term = everySet(sets);
      if (axis && value !== undefined) term[axis] = new Set([value]);
      resolved.set(id, [term]);
      continue;
    }
    if (node.level === "context") {
      resolved.set(id, [selectorOf(node, sets)]);
      continue;
    }
    const seen = new Map<string, AudienceTerm>();
    for (const parentId of graph.parents.get(id) ?? []) {
      for (const term of resolved.get(parentId) ?? []) seen.set(termKey(term, axes), term);
    }
    // Absorb HERE, where the term is produced — not in formatAudience, where it
    // is printed. A redundant term is invisible at the surface either way, so
    // moving this to the end reads as a no-op and is not: the term is inherited
    // by every node below, and the disjunction grows down the graph while
    // describing exactly the same people. Pinned by "a term another term already
    // covers is absorbed where it is produced" in test/audience.test.mjs, which
    // exists because the whole suite passed with this call removed.
    //
    // An empty union stays empty: a node with no resolvable parent serves nobody
    // in particular rather than everybody, since claiming the whole product from
    // an absent lineage would be a scope nothing justified.
    resolved.set(id, simplifyAudience([...seen.values()], axes));
  }
  return resolved;
}

export type AudienceTuple = Record<string, string>;

export function termMatches(term: AudienceTerm, tuple: AudienceTuple): boolean {
  for (const [axis, value] of Object.entries(tuple)) {
    const allowed = term[axis];
    if (allowed === undefined || allowed === "*") continue;
    if (!allowed.has(value)) return false;
  }
  return true;
}

export function audienceMatches(audience: Audience, tuple: AudienceTuple): boolean {
  return audience.some((term) => termMatches(term, tuple));
}

/** True when two audiences share at least one member. Never enumerates. */
export function audienceOverlaps(left: Audience, right: Audience, axes: string[]): boolean {
  return left.some((one) =>
    right.some((other) =>
      axes.every((axis) => {
        const a = one[axis];
        const b = other[axis];
        if (a === undefined || a === "*" || b === undefined || b === "*") return true;
        for (const value of a) if (b.has(value)) return true;
        return false;
      }),
    ),
  );
}

/** True when `inner` is contained in `outer`, so a change from outer to inner narrows. */
export function audienceContains(outer: Audience, inner: Audience, axes: string[]): boolean {
  return inner.every((term) =>
    outer.some((candidate) =>
      axes.every((axis) => {
        const wide = candidate[axis];
        const narrow = term[axis];
        if (wide === undefined || wide === "*") return true;
        if (narrow === undefined || narrow === "*") return false;
        for (const value of narrow) if (!wide.has(value)) return false;
        return true;
      }),
    ),
  );
}

/**
 * The audience a set of nodes serves between them.
 *
 * A lineage view lists the audience NODES it passed through, and a wildcard is
 * not a node, so that list under-reports: a file reached through `role.*` shows
 * the one conjunctive parent it also has and reads as scoped to it. The
 * resolved answer is the one worth printing beside the lineage.
 */
export function combinedAudience(
  resolved: Map<string, Audience>,
  ids: string[],
  axes: string[],
): Audience {
  const seen = new Map<string, AudienceTerm>();
  for (const id of ids) {
    for (const term of resolved.get(id) ?? []) seen.set(termKey(term, axes), term);
  }
  return [...seen.values()];
}

/** True when `wide` covers everyone `narrow` covers, so `narrow` adds nothing. */
function subsumes(wide: AudienceTerm, narrow: AudienceTerm, axes: string[]): boolean {
  return axes.every((axis) => {
    const outer = wide[axis];
    const inner = narrow[axis];
    if (outer === undefined || outer === "*") return true;
    if (inner === undefined || inner === "*") return false;
    for (const value of inner) if (!outer.has(value)) return false;
    return true;
  });
}

/**
 * Drop terms another term already covers.
 *
 * A node inheriting from a universal parent and a narrow one unions to both,
 * and the narrow term then describes nobody the wide one missed. Keeping it
 * would print a scope that reads as two audiences and grow the term count on
 * every level below for no added meaning.
 */
export function simplifyAudience(audience: Audience, axes: string[]): Audience {
  return audience.filter(
    (term, index) =>
      !audience.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          subsumes(other, term, axes) &&
          // Keep exactly one of a pair that covers each other.
          (!subsumes(term, other, axes) || otherIndex < index),
      ),
  );
}

/**
 * Name only the sets that constrain the audience. A set left unnamed means it
 * does not narrow anything, which is the same convention a Context is written
 * in, so the printed scope reads the way the node that produced it was written.
 */
export function formatAudience(audience: Audience, axes: string[]): string {
  if (audience.length === 0) return "(none)";
  const rendered = simplifyAudience(audience, axes).map((term) => {
    const named = axes
      .filter((axis) => term[axis] !== undefined && term[axis] !== "*")
      .map((axis) => `${axis}=${[...(term[axis] as Set<string>)].sort().join("+")}`);
    return named.length === 0 ? "everyone" : named.join(", ");
  });
  return [...new Set(rendered)].sort().join(" or ");
}

/** Parse `role=admin,segment=enterprise` into a selector term. */
export function parseSelector(input: string, sets: Map<string, string[]>): AudienceTerm {
  const term = everySet(sets);
  for (const part of input.split(",").map((item) => item.trim()).filter(Boolean)) {
    const [axis, value] = part.split("=").map((item) => item.trim());
    if (!axis || !value) throw new Error(`Selector must be <set>=<value>, got: ${part}`);
    if (!sets.has(axis)) {
      throw new Error(`Unknown audience set "${axis}". Known sets: ${[...sets.keys()].sort().join(", ")}`);
    }
    if (!sets.get(axis)!.includes(value)) {
      throw new Error(`Unknown value "${value}" in audience set "${axis}".`);
    }
    const current = term[axis];
    if (current === undefined || current === "*") term[axis] = new Set([value]);
    else current.add(value);
  }
  return term;
}
