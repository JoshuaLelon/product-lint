/**
 * What a suggestion does to the graph, said in the words the graph already uses.
 *
 * `product-lint diff` reports claims as added, removed and restated, and the
 * commit trailers are Knowledge-Change, Knowledge-Removed and Knowledge-Renamed.
 * A changeset here speaks the same four words, so a proposal reads the same as
 * the diff it will produce and the commit that will carry it. Inventing
 * create/update/delete would have given the same facts a second vocabulary.
 *
 * `regoverned` is the fifth, and the one the product has no word for yet: the
 * statement does not move but its `constrainedBy` does, so the claim now answers
 * to different claims above it. `NODE_SHAPE` asks for exactly this more often
 * than for anything else — "add your parent to its constrainedBy list instead".
 */
import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { serializeNode } from "../src/graph.js";
import { KNOWLEDGE_LEVELS } from "../src/types.js";
import { audienceAxis, audienceValue, isAudienceWildcard } from "../src/audience.js";
import type { KnowledgeLevel, ResolvedConfig } from "../src/types.js";
import { ROOT, type GraphView } from "./graph.js";

export type Change =
  | { kind: "restated"; id: string; statement: string }
  | { kind: "regoverned"; id: string; constrainedBy: string[] }
  | { kind: "added"; level: KnowledgeLevel; statement: string; constrainedBy: string[] }
  | { kind: "withdrawn"; id: string };

export interface Suggestion {
  /** One line saying what this would do, for the reader to choose by. */
  title: string;
  /**
   * A few sentences of plain English: what this does, and why it is worth doing.
   *
   * The reviewer is being asked to accept a change to claims they wrote, and a
   * one-line title cannot carry the reason. This is prose ABOUT the graph rather
   * than a claim in it, so it is not held to `STATEMENT_STYLE` — it is allowed
   * to say "because" and to name a trade-off, which a claim is not.
   */
  summary: string;
  changes: Change[];
}

/** Ids are derived from the statement, the way `adopt` derives them from a path. */
export function idFor(level: string, statement: string, taken: Set<string>): string {
  const slug =
    statement
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .split("-")
      .slice(0, 8)
      .join("-") || "node";
  let id = `${level}.${slug}`;
  for (let n = 2; taken.has(id); n += 1) id = `${level}.${slug}-${n}`;
  return id;
}

/**
 * Whether two changes say the same thing.
 *
 * Used to mark what an amendment moved. The reader asked to keep some of a
 * suggestion and change the rest, so the answer is only readable if the parts
 * that survived are visibly the parts that survived — and that is a comparison
 * of two changesets, which is arithmetic rather than a thing to ask a model
 * about.
 */
export function sameChange(left: Change, right: Change): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "restated" && right.kind === "restated") {
    return left.id === right.id && left.statement === right.statement;
  }
  if (left.kind === "withdrawn" && right.kind === "withdrawn") return left.id === right.id;
  const key = (ids: readonly string[]) => [...ids].sort().join("\u0000");
  if (left.kind === "regoverned" && right.kind === "regoverned") {
    return left.id === right.id && key(left.constrainedBy) === key(right.constrainedBy);
  }
  if (left.kind === "added" && right.kind === "added") {
    return (
      left.level === right.level &&
      left.statement === right.statement &&
      key(left.constrainedBy) === key(right.constrainedBy)
    );
  }
  return false;
}

/** Everything a change would touch, for showing what rests on it before accepting. */
export function affected(view: GraphView, change: Change): string[] {
  if (change.kind === "added") return [];
  return [...(view.children.get(change.id) ?? [])];
}

/**
 * Refuse a changeset that names something that is not there.
 *
 * A model asked for operations will occasionally invent an id or a level. Every
 * such change is dropped rather than written, because a proposal that half
 * applies leaves the graph in a state nobody chose.
 *
 * The argument is typed `Change[]` but arrives as parsed JSON, so nothing here
 * may assume a field is present: a reply that omits `constrainedBy` used to
 * throw out of the one function whose job is to reject it, which took the
 * editor down rather than dropping the change. Every field is read through a
 * check, and anything that does not answer is simply not usable.
 */
function statement(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * A parent is a node, or an audience set.
 *
 * `audience.<set>.*` is a legal parent for a Context and is not a node id, so
 * checking `byId` alone calls the graph's own context nodes invalid — every one
 * of them names `audience.role.*`. The library says so in the words it gives the
 * reader when this is wrong: "a Context may name an audience set with
 * audience.<set>.*". A wildcard counts only where the set has values, which is
 * the same condition `remediation` states for it.
 */
function wildcardsOf(view: GraphView): Set<string> {
  const axes = new Set<string>();
  for (const node of view.byId.values()) {
    if (node.level !== "audience") continue;
    const axis = audienceAxis(node.id);
    if (axis && audienceValue(node.id) !== undefined) axes.add(axis);
  }
  return new Set([...axes].map((axis) => `audience.${axis}.*`));
}

function known(view: GraphView, wildcards: Set<string>, value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every(
      (id) =>
        typeof id === "string" &&
        (view.byId.has(id) || (isAudienceWildcard(id) && wildcards.has(id))),
    )
  );
}

export function usable(view: GraphView, changes: Change[]): Change[] {
  const wildcards = wildcardsOf(view);
  return changes.filter((change) => {
    if (!change || typeof change !== "object") return false;
    if (change.kind === "added") {
      return (
        KNOWLEDGE_LEVELS.includes(change.level) &&
        statement(change.statement).length > 0 &&
        known(view, wildcards, change.constrainedBy) &&
        (change.constrainedBy.length > 0 || change.level === "audience")
      );
    }
    if (typeof change.id !== "string" || !view.byId.has(change.id)) return false;
    if (change.kind === "restated") {
      // A restatement to the words already there is not a change, and the
      // reviewer was being shown it as one: a `−` and a `+` holding the same
      // sentence, under a title that said no change was needed. Asked for three
      // suggestions the model will pad, and a no-op is the cheapest padding, so
      // this has to be caught here rather than hoped away in the prompt.
      const now = view.byId.get(change.id)?.statement ?? "";
      return statement(change.statement).length > 0 && statement(change.statement) !== statement(now);
    }
    if (change.kind === "regoverned") {
      // Empty is right for exactly one level. `remediation` puts it plainly:
      // "An Audience node uses an empty array. Every other level lists its
      // direct parents." Refusing it everywhere made the editor stricter than
      // the linter, which is the one way it is not allowed to differ.
      // `known` first, and nothing reads the list before it: it is what narrows
      // an untrusted field to an array, and reaching past it for a `.length`
      // put the throw back into the one function whose job is to refuse.
      if (!known(view, wildcards, change.constrainedBy)) return false;
      // Same rule as a restatement: regoverning a claim to the parents it
      // already has moves nothing.
      const now = view.byId.get(change.id)?.constrainedBy ?? [];
      const key = (ids: readonly string[]) => [...ids].sort().join("\u0000");
      if (now.length === change.constrainedBy.length && key(now) === key(change.constrainedBy)) {
        return false;
      }
      return change.constrainedBy.length > 0 || view.byId.get(change.id)?.level === "audience";
    }
    return change.kind === "withdrawn";
  });
}

/**
 * Write a changeset to disk.
 *
 * Every file goes through the library's own serializer, so what this writes is
 * byte-identical to what `sync` and `adopt` would write. Additions come last:
 * a new node may name a node an earlier change regoverned, and reading the
 * graph back afterwards is what tells you whether the whole set holds together.
 */
export async function apply(
  config: ResolvedConfig,
  view: GraphView,
  changes: Change[],
): Promise<void> {
  const order = { restated: 0, regoverned: 1, withdrawn: 2, added: 3 } as const;
  const taken = new Set(view.byId.keys());

  for (const change of [...changes].sort((a, b) => order[a.kind] - order[b.kind])) {
    if (change.kind === "withdrawn") {
      const node = view.byId.get(change.id);
      if (node) await rm(path.resolve(ROOT, node.sourcePath), { force: true });
      continue;
    }
    if (change.kind === "added") {
      const id = idFor(change.level, change.statement, taken);
      taken.add(id);
      const directory = config.canonicalRoots[change.level];
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, `${id.slice(id.indexOf(".") + 1)}.json`);
      await writeFile(
        file,
        serializeNode({
          $schema: "../../schema/canonical-node.schema.json",
          id,
          level: change.level,
          statement: change.statement,
          constrainedBy: change.constrainedBy,
          sourcePath: path.relative(ROOT, file),
        }),
        "utf8",
      );
      continue;
    }
    const node = view.byId.get(change.id);
    if (!node) continue;
    const next =
      change.kind === "restated"
        ? { ...node, statement: change.statement }
        : { ...node, constrainedBy: change.constrainedBy };
    await writeFile(path.resolve(ROOT, node.sourcePath), serializeNode(next), "utf8");
  }
}
