/**
 * The five ways of looking at the graph.
 *
 * Each view answers "for the node I am on, show me ___", and each produces the
 * same three things: a layout to draw, the order the cursor walks, and the set
 * of nodes the current selection lights up. Everything downstream — the
 * vocabulary pane, the references pane, the actions — reads those three and
 * never needs to know which view produced them.
 *
 * There are five views but only three layouts, because level and path are the
 * same shape with different contents, and the three tree views are one traversal
 * with a direction. Building five bespoke screens would have let them drift
 * apart, and most of what a view "is" turns out to be which nodes it picks.
 */
import { KNOWLEDGE_LEVELS } from "../src/types.js";
import type { GraphView } from "./graph.js";
import { pathsThrough, pathsTo } from "./graph.js";

export type ViewId = "level" | "path" | "descending" | "ascending" | "hourglass";

/** A level's worth of nodes in the level view. */
export interface Band {
  level: string;
  /** The band the focused node sits in, drawn as cards rather than a list. */
  current: boolean;
  ids: string[];
}

export type TreeRow =
  | {
      kind: "node";
      id: string;
      /** Indent and branch characters for the row a node starts on. */
      prefix: string;
      /**
       * The same indent without the branch, for a node that occupies more than
       * one row. A card is several rows tall, so its later rows need the
       * ancestors' vertical bars carried down but not its own elbow repeated.
       */
      cont: string;
      /**
       * A node already drawn higher up, reached again by another parent. The
       * graph is a DAG, so this happens; repeating the whole subtree would say
       * the same thing twice without admitting they are one node.
       */
      reentry: boolean;
    }
  /** Names the half of an hourglass that follows. */
  | { kind: "label"; text: string };

export interface PathStep {
  id: string;
  /** Nodes the step before it also constrains — the alternatives to this choice. */
  sameParent: string[];
  /** The rest of the level, which the step before it does not constrain. */
  sameLevel: string[];
  /**
   * What this step would become on the previous or next selection, when the two
   * paths differ here.
   *
   * Cycling selections was a blind jump: the counter said 2 of 3 and nothing
   * said what the third was. Naming the swap before it happens turns the arrow
   * from a guess into a choice.
   */
  swapPrev?: string;
  swapNext?: string;
}

export type Layout =
  | { kind: "bands"; bands: Band[] }
  | { kind: "tree"; rows: TreeRow[] }
  | { kind: "path"; steps: PathStep[] };

export interface Rendering {
  layout: Layout;
  /** Every focusable node, in the order the cursor walks them. */
  order: string[];
  /** What the current selection covers. The side panes are computed from this. */
  lit: string[];
  /**
   * The path the actions run against.
   *
   * Actions are typed on the shape of a selection, so they need a path even in
   * views that do not present one. Path view hands over the path you picked;
   * every other view hands over the first path to the focused node, which is the
   * same thing those views were already implying by focusing it.
   */
  path: string[];
  /**
   * Nodes the view shows beside the cursor that are worth moving to, but that
   * moving the cursor should not stumble into.
   *
   * Path view's alternatives are the case: they are the point of the column, but
   * focusing one rebuilds the whole path around it, so walking onto one by
   * accident would rewrite the screen. They get their own pane instead — browse
   * with the arrows, commit with enter — which is how every other pane here
   * already works.
   */
  aside: string[];
  /**
   * What each entry in `aside` is to the cursor's step: a sibling shares its
   * parent, a cousin only shares its level. Two different questions — "what else
   * did this constraint produce" and "what else does this level say" — so they
   * are named apart rather than run together as one list.
   */
  asideKinds: string[];
  /** How many selections left and right cycle through. */
  selections: number;
  /** What the footer says about the selection, when there is more than one. */
  caption: string;
}

function atLevel(view: GraphView, level: string): string[] {
  return [...view.byId.values()]
    .filter((node) => node.level === level)
    .map((node) => node.id)
    .sort();
}

/**
 * Walk a DAG as a tree, drawing each node once.
 *
 * `seen` is checked before descending rather than before emitting, so a node
 * reached twice still appears in both places — the shape of the graph is the
 * point of a tree view — but only the first occurrence carries its subtree.
 */
function tree(
  edges: Map<string, Set<string>>,
  root: string,
  seen = new Set<string>(),
): TreeRow[] {
  const rows: TreeRow[] = [];

  const walk = (id: string, ancestorsLast: boolean[]) => {
    const indent = ancestorsLast
      .slice(0, -1)
      .map((last) => (last ? "   " : "│  "))
      .join("");
    const branch = ancestorsLast.length === 0 ? "" : ancestorsLast.at(-1) ? "└─ " : "├─ ";
    const carry = ancestorsLast.length === 0 ? "" : ancestorsLast.at(-1) ? "   " : "│  ";
    const reentry = seen.has(id);
    rows.push({ kind: "node", id, prefix: indent + branch, cont: indent + carry, reentry });
    if (reentry) return;
    seen.add(id);
    const next = [...(edges.get(id) ?? [])].sort();
    next.forEach((child, index) => walk(child, [...ancestorsLast, index === next.length - 1]));
  };

  walk(root, []);
  return rows;
}

/** Ordered, de-duplicated: a tree may name a node twice, the cursor must not. */
function focusOrder(rows: TreeRow[]): string[] {
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const row of rows) {
    if (row.kind !== "node" || seen.has(row.id)) continue;
    seen.add(row.id);
    ids.push(row.id);
  }
  return ids;
}

/**
 * The two directions, named so neither can be read as the other.
 *
 * A claim rests on what constrains it, and what it constrains rests on it. The
 * graph says both in those words. A bare "rests on 2" drops the pronoun that
 * carries the direction and can be read either way; keeping the whole phrase is
 * three characters and cannot be.
 */
const upward = (count: number) =>
  count === 0 ? "it rests on nothing" : `what it rests on (${count})`;
const downward = (count: number) =>
  count === 0 ? "nothing rests on it" : `what rests on it (${count})`;

/** Several roots into one tree, sharing `seen` so a shared node is drawn once. */
function forest(edges: Map<string, Set<string>>, roots: string[]): TreeRow[] {
  const seen = new Set<string>();
  return roots.flatMap((root) => tree(edges, root, seen));
}

/** Everything the focus rests on, however far up. */
function ancestorsOf(view: GraphView, focus: string): Set<string> {
  const found = new Set<string>();
  const stack = [focus];
  while (stack.length > 0) {
    for (const parent of view.parents.get(stack.pop()!) ?? []) {
      if (found.has(parent)) continue;
      found.add(parent);
      stack.push(parent);
    }
  }
  return found;
}

/**
 * The cone above the focus, drawn the way every other tree here is drawn.
 *
 * The earlier note said reversing the rows was wrong, and it was: the branch
 * characters encode a top-down tree, so a reversed list draws `└─` above the
 * thing it hangs from. But the conclusion drawn from that — root both halves at
 * the focus and let the headings say which way is which — made the ascending
 * half read downward while the descending half read downward too, so the same
 * gesture meant "further from the focus" in one and "further from the top" in
 * the other. Nothing on the screen said which.
 *
 * The fix is not to reverse anything. It is to walk the ancestors in the SAME
 * direction as everything else — from the claims nothing constrains, down
 * through `children`, arriving at the focus — so shallower is always higher and
 * the connectors mean one thing everywhere. `stopAt` bounds the walk to the
 * cone, so a parent's other descendants are not dragged in.
 */
function above(view: GraphView, focus: string, through: boolean): {
  edges: Map<string, Set<string>>;
  roots: string[];
} {
  const cone = ancestorsOf(view, focus);
  const edges = new Map<string, Set<string>>();
  for (const id of cone) {
    const next = [...(view.children.get(id) ?? [])].filter(
      (child) => cone.has(child) || child === focus,
    );
    edges.set(id, new Set(next));
  }
  // Below the focus the cone opens up again, so the descendant edges are taken
  // whole. `through` is what makes the hourglass one tree rather than two.
  if (through) {
    const stack = [focus];
    const walked = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (walked.has(id)) continue;
      walked.add(id);
      const next = [...(view.children.get(id) ?? [])];
      edges.set(id, new Set(next));
      stack.push(...next);
    }
  }
  const roots = [...cone].filter((id) => ![...(view.parents.get(id) ?? [])].some((p) => cone.has(p)));
  return { edges, roots: roots.length > 0 ? roots.sort() : [focus] };
}

export interface View {
  id: ViewId;
  label: string;
  /**
   * `anchor` is what the view is built from; `cursor` is where the reader is.
   *
   * They have to be separate. A view built from the node the arrows move is
   * circular: pressing down re-roots the tree, so `order` changes underneath the
   * press and down-then-up does not come back. The anchor only moves when the
   * reader says so.
   */
  build(view: GraphView, anchor: string, selection: number, cursor: string): Rendering;
}

export const VIEWS: View[] = [
  {
    id: "level",
    label: "level",
    /**
     * Centred on the CURSOR, not the anchor.
     *
     * Every other view is built from the anchor, because building a view from
     * the thing the arrows move is circular — the tree re-roots under the press
     * and down-then-up does not come back. A band is different: the bands are
     * chosen by LEVEL, and every node in a band shares one, so walking within a
     * band changes nothing and walking out of it is exactly the moment the
     * reader has asked to look at the next stratum. Following the cursor is what
     * makes the level you moved into open as cards and the one you left collapse
     * to a list; anchored, you had to press ⏎ to be shown where you already were.
     */
    build(view, _anchor, _selection, cursor) {
      const focus = cursor;
      const node = view.byId.get(focus);
      const index = node ? KNOWLEDGE_LEVELS.indexOf(node.level) : 0;
      const bands: Band[] = [];
      for (const offset of [-1, 0, 1]) {
        const level = KNOWLEDGE_LEVELS[index + offset];
        if (!level) continue;
        bands.push({ level, current: offset === 0, ids: atLevel(view, level) });
      }
      // What this node touches in the bands either side of it, which is the
      // question the neighbouring lists exist to answer.
      const lit = [focus, ...(view.parents.get(focus) ?? []), ...(view.children.get(focus) ?? [])];
      return {
        layout: { kind: "bands", bands },
        order: bands.flatMap((band) => band.ids),
        lit,
        path: pathsTo(view, focus)[0] ?? [focus],
        aside: [],
        asideKinds: [],
        selections: 1,
        caption: node?.level ?? "",
      };
    },
  },

  {
    id: "path",
    label: "path",
    build(view, focus, selection, cursor) {
      const paths = pathsThrough(view, focus);
      const count = Math.max(paths.length, 1);
      const at = selection % count;
      const path = paths[at] ?? [focus];
      const prev = paths[(at - 1 + count) % count] ?? path;
      const next = paths[(at + 1) % count] ?? path;
      const steps: PathStep[] = path.map((id, index) => {
        const node = view.byId.get(id);
        const parent = index > 0 ? path[index - 1] : undefined;
        // Two questions, kept apart. Same parent asks what else this constraint
        // produced; same level asks what else was said here at all. Folding them
        // together would make one column mean whichever happened to be true.
        const sameParent = parent
          ? [...(view.children.get(parent) ?? [])].filter((other) => other !== id).sort()
          : [];
        const claimed = new Set([id, ...sameParent]);
        const sameLevel = node
          ? atLevel(view, node.level).filter((other) => !claimed.has(other))
          : [];
        return {
          id,
          sameParent,
          sameLevel,
          swapPrev: prev[index] !== id ? prev[index] : undefined,
          swapNext: next[index] !== id ? next[index] : undefined,
        };
      });
      const step = steps.find((each) => each.id === cursor) ?? steps.at(-1);
      return {
        layout: { kind: "path", steps },
        order: path,
        lit: path,
        path,
        // The alternatives to the step the cursor is on, in the order they are
        // drawn: what this constraint also produced, then the rest of the level.
        // The alternatives belong to the step the CURSOR is on, not the anchor:
        // they are what you would have chosen instead of where you are looking.
        // Only that step's, too — every step's at once was a wall of clipped
        // lines that answered no question you could have been asking.
        aside: step ? [...step.sameParent, ...step.sameLevel] : [],
        asideKinds: step
          ? [...step.sameParent.map(() => "sibling"), ...step.sameLevel.map(() => "cousin")]
          : [],
        selections: Math.max(paths.length, 1),
        caption: `path ${(selection % Math.max(paths.length, 1)) + 1}/${paths.length}`,
      };
    },
  },

  /**
   * The three tree views are one traversal read top to bottom.
   *
   * Whatever the view, higher on the screen means closer to the audience and
   * lower means closer to the files, because that is what a level IS here. A
   * view that inverted it for one half would make the same downward gesture mean
   * "deeper" in one place and "shallower" in another, and nothing on the screen
   * would say which — so the cursor's meaning would depend on which half of
   * which view it happened to be in.
   *
   * The captions borrow the graph's own two phrases rather than inventing a
   * pair. `carries` was invented here and appears nowhere else in the product;
   * a bare `rests on 2` was worse than invented, because it reads equally as
   * "rests on two things" and "two things rest on it", which are opposite
   * directions. Naming them in full — what it rests on, what rests on it —
   * costs three words and cannot be read backwards.
   */
  {
    id: "descending",
    label: "down",
    build(view, focus) {
      const rows = tree(view.children, focus);
      const order = focusOrder(rows);
      return {
        layout: { kind: "tree", rows },
        order,
        lit: order,
        path: pathsTo(view, focus)[0] ?? [focus],
        aside: [],
        asideKinds: [],
        selections: 1,
        caption: downward(order.length - 1),
      };
    },
  },

  {
    id: "ascending",
    label: "up",
    build(view, focus) {
      const { edges, roots } = above(view, focus, false);
      const rows = forest(edges, roots);
      const order = focusOrder(rows);
      return {
        layout: { kind: "tree", rows },
        order,
        lit: order,
        path: pathsTo(view, focus)[0] ?? [focus],
        aside: [],
        asideKinds: [],
        selections: 1,
        caption: upward(order.length - 1),
      };
    },
  },

  {
    id: "hourglass",
    label: "hourglass",
    build(view, focus) {
      // One tree, not two cones with headings between them. The ancestors walk
      // down into the focus and the focus walks on down into its descendants, so
      // the whole cone is a single line of descent that happens to pass through
      // the node you are on — which is what an hourglass is.
      const { edges, roots } = above(view, focus, true);
      const rows = forest(edges, roots);
      const order = focusOrder(rows);
      const up = ancestorsOf(view, focus).size;
      return {
        layout: { kind: "tree", rows },
        order,
        lit: order,
        path: pathsTo(view, focus)[0] ?? [focus],
        aside: [],
        asideKinds: [],
        selections: 1,
        caption: `${upward(up)} · ${downward(order.length - 1 - up)}`,
      };
    },
  },
];

export function viewById(id: ViewId): View {
  return VIEWS.find((view) => view.id === id) ?? VIEWS[0];
}
