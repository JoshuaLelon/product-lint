/**
 * What the nodes you picked are TO EACH OTHER.
 *
 * The panel used to list them, which said only that you had picked three things.
 * But a set of claims in this graph is almost never unrelated: two claims at the
 * same level are alternatives, two with one parent are the answers that
 * constraint produced, and two on one path are a single line of descent with
 * steps in between that you did not pick but that are part of what relates them.
 * A list throws all of that away and makes the reader rebuild it from the level
 * prefixes.
 *
 * So the panel asks the graph what shape the picked set has, and draws that
 * shape. The four cases are ordered by how much they claim: a path says the most
 * (these lie on one line, and here is the line), a shared parent next, a shared
 * level next, and unrelated is what is left when the graph says nothing at all.
 * The first that fits wins, because a set that is both siblings and same-level is
 * better described as siblings — that is the stronger, more specific fact.
 */
import { pathsThrough } from "./graph.js";
import type { GraphView } from "./graph.js";

export type Grouping =
  /**
   * One line of descent through all of them. `ids` is the whole line, including
   * the steps nobody picked: they are why the picked ones are related, so
   * hiding them would draw a path with its middle missing.
   */
  | { kind: "path"; ids: string[] }
  /** One claim constrains all of them. */
  | { kind: "siblings"; parent: string; ids: string[] }
  /** The same stratum, but no one claim above them all. */
  | { kind: "level"; level: string; ids: string[] }
  /** The graph relates them in none of the ways above. */
  | { kind: "scattered"; ids: string[] };

function commonParents(view: GraphView, ids: string[]): string[] {
  if (ids.length === 0) return [];
  let shared = [...(view.parents.get(ids[0]!) ?? [])];
  for (const id of ids.slice(1)) {
    const parents = view.parents.get(id) ?? new Set<string>();
    shared = shared.filter((parent) => parents.has(parent));
  }
  return shared.sort();
}

export function groupOf(view: GraphView, picked: string[]): Grouping {
  const ids = picked.filter((id) => view.byId.has(id));
  if (ids.length === 0) return { kind: "scattered", ids: [] };
  if (ids.length === 1) {
    const level = view.byId.get(ids[0]!)!.level;
    return { kind: "level", level, ids };
  }

  // A single line that passes through every one of them. Asked of the graph
  // rather than reconstructed here, so the panel and the path view cannot
  // disagree about what a path is.
  for (const id of ids) {
    for (const line of pathsThrough(view, id)) {
      if (ids.every((each) => line.includes(each))) return { kind: "path", ids: line };
    }
  }

  const shared = commonParents(view, ids);
  if (shared.length > 0) return { kind: "siblings", parent: shared[0]!, ids: [...ids].sort() };

  const levels = new Set(ids.map((id) => view.byId.get(id)!.level));
  if (levels.size === 1) {
    return { kind: "level", level: [...levels][0]!, ids: [...ids].sort() };
  }

  return { kind: "scattered", ids: [...ids].sort() };
}

/**
 * Exactly how many rows the panel will draw.
 *
 * Read by the layout that draws it AND by the app that budgets for it, because
 * the two disagreeing is what pushed the frame past the bottom of the terminal
 * and scrolled its top away. One function, so a shape that grows a row cannot
 * grow it in only one of the two places.
 */
export function selectionRows(group: Grouping, cap: number): number {
  const listed = Math.min(group.ids.length, cap);
  const overflow = group.ids.length > cap ? 1 : 0;
  const heading = 1;
  if (group.kind === "siblings") return heading + 1 + listed + overflow;
  if (group.kind === "level") return heading + 2 + listed + overflow;
  return heading + listed + overflow;
}

/** What the heading says the graph found, in the graph's own words. */
export function describe(group: Grouping, picked: number): string {
  if (group.kind === "path") return `${picked} picked · one line of descent`;
  if (group.kind === "siblings") return `${picked} picked · one claim constrains them`;
  if (group.kind === "level") return `${picked} picked · all ${group.level}`;
  return `${picked} picked · unrelated`;
}
