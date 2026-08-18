/**
 * Every key the editor answers to, written down once, per screen.
 *
 * It was written down twice before, badly: a hand-typed hint line along the
 * bottom, and the action menu's own list. The hint line had already drifted — it
 * never mentioned `s`, which is the key that opens suggestions, so the one way
 * to find the feature was to be told about it.
 *
 * The table is now keyed by SCREEN rather than by key, because that is the
 * question a reader actually has: not "when is `a` live" but "what can I do from
 * here". A key that does two things in two places gets a row in each, saying
 * what it does THERE — `a` opens the actions menu on the graph and applies a
 * proposal while reviewing one, and a single row could only have lied about one
 * of them.
 *
 * Written from `useInput` in `app.tsx`, branch by branch. Reading it that way
 * caught a map that was already wrong: `r`, `c` and `p` were filed under "when
 * the menu is open", and they are dispatched at the end of the handler whatever
 * mode you are in — the menu only LISTS them. Keep this file honest by rereading
 * that function, not by reasoning about what the keys ought to do.
 *
 * The vim aliases are deliberately absent: `j`/`k` and `h`/`l` do exactly what
 * the arrows do, and a guide that shows one action twice is longer without being
 * more useful.
 */
import { ACTIONS } from "./actions.js";

export interface KeyState {
  mode: string;
  /** Whether a suggestion has arrived and can be acted on. */
  reviewing: boolean;
  /** Which view the graph pane is showing — the views are different screens. */
  view: string;
  /**
   * How many paths run through the node the cursor is on.
   *
   * `← →` cycles them, so with one path it does nothing at all — which is what
   * the level view was advertising, a key that moved nothing.
   */
  paths: number;
  /** Which pane takes the arrows, because that changes what they walk. */
  pane: string;
}

export interface Key {
  press: string;
  /** What it does HERE, in the words the rest of the editor uses. */
  does: string;
  group: string;
  /** Also shown on the one line along the bottom. */
  brief?: boolean;
  /** A shorter wording for that line only, where the row is tight. */
  short?: string;
}

export type ScreenId =
  | "typing"
  | "suggestion"
  | "waiting"
  | "acting"
  | "menu"
  | "alternatives"
  | "graph";

export interface Screen {
  id: ScreenId;
  /** What the reader would call where they are. */
  title(state: KeyState): string;
  when(state: KeyState): boolean;
  /**
   * Taken as a function of state, not a fixed list.
   *
   * The arrows are the reason. `← →` cycles the paths through a node, so it does
   * nothing where there is only one — and the level view was advertising it
   * anyway. The same keys also walk different things depending on which pane has
   * them. A screen whose keys cannot depend on any of that can only be accurate
   * by accident.
   */
  keys(state: KeyState): Key[];
}

/**
 * Groups are of two kinds and the difference is deliberate. A verb — move, look,
 * choose, consult, finish — is a thing you do. Screens are named by where you
 * are, so the group never has to be.
 */
const moving: Key[] = [
  { press: "↑ ↓", does: "node", group: "move", brief: true },
  { press: "← →", does: "path", group: "move", brief: true },
];

const looking: Key[] = [
  { press: "tab", does: "view", group: "look", brief: true },
  { press: "⇧tab", does: "view back", group: "look" },
  { press: "[ ]", does: "pane", group: "look", brief: true },
];

/** The guide can be reached from anywhere except mid-sentence, where it types. */
const theseKeys: Key = {
  press: "?",
  does: "these keys",
  short: "keys",
  group: "look",
  brief: true,
};

/**
 * The action keys reach their action directly, from any screen that falls
 * through to them — the menu is a list of what is available, not a gate.
 */
const actions: Key[] = ACTIONS.map((action) => ({
  press: action.key,
  does: action.label,
  group: "consult",
}));

/** What the arrows walk depends on which pane has them. */
function walks(pane: string): string {
  if (pane === "alternatives") return "alternative";
  if (pane === "selection") return "picked node";
  if (pane === "graph") return "node";
  return "scroll";
}

/** The keys that work on the graph whatever view is showing. */
function onTheGraph(state: KeyState): Key[] {
  return [
    { press: "↑ ↓", does: walks(state.pane), group: "move", brief: true },
    // Only where there is more than one path to cycle. In the level view and the
    // trees there is exactly one, and the key moved nothing while the guide went
    // on promising it would.
    ...(state.paths > 1
      ? [{ press: "← →", does: "path", group: "move", brief: true } as Key]
      : []),
    ...looking,
    theseKeys,
    {
      press: "␣",
      does: state.pane === "selection" ? "unpick" : "pick",
      group: "choose",
      brief: true,
    },
    { press: "⏎", does: "anchor here", short: "anchor", group: "choose", brief: true },
    { press: "a", does: "actions", group: "consult", brief: true },
    { press: "s", does: "suggestions", short: "suggest", group: "consult", brief: true },
    ...actions,
    { press: "q esc", does: "quit", short: "quit", group: "finish", brief: true },
  ];
}

export const SCREENS: Screen[] = [
  {
    id: "typing",
    title: () => "typing at a suggestion",
    when: (state) => state.mode === "talking",
    // No `?` here on purpose: a question containing a question mark is the
    // ordinary case, so mid-sentence that key is a character like any other.
    keys: () => [
      { press: "tab", does: "swap ask and amend", group: "choose" },
      { press: "⏎", does: "send", group: "finish" },
      { press: "esc", does: "cancel", group: "finish" },
    ],
  },
  {
    id: "suggestion",
    title: () => "a suggestion",
    when: (state) => state.mode === "suggestions" && state.reviewing,
    keys: () => [
      { press: "↑ ↓", does: "suggestion", group: "move", brief: true },
      { press: "/", does: "ask or amend", group: "consult", brief: true },
      theseKeys,
      { press: "y", does: "accept", group: "finish", brief: true },
      { press: "esc", does: "back", group: "finish", brief: true },
    ],
  },
  {
    id: "waiting",
    title: () => "waiting for suggestions",
    when: (state) => state.mode === "suggestions",
    keys: () => [theseKeys, { press: "esc", does: "back", group: "finish", brief: true }],
  },
  {
    id: "acting",
    title: () => "a proposal",
    when: (state) => state.mode === "acting",
    keys: () => [
      ...looking,
      theseKeys,
      // `a` is the one key that means something different here than on the
      // graph, where it opens the menu this proposal came out of.
      { press: "a", does: "apply it", group: "finish", brief: true },
      { press: "1 2 3", does: "apply that wording", group: "finish" },
      { press: "esc", does: "back", group: "finish", brief: true },
    ],
  },
  {
    id: "menu",
    title: () => "the actions menu",
    when: (state) => state.mode === "menu",
    keys: () => [
      ...actions,
      ...looking,
      theseKeys,
      { press: "esc", does: "back", group: "finish", brief: true },
    ],
  },
  {
    id: "alternatives",
    title: () => "the alternatives pane",
    when: (state) => state.pane === "alternatives",
    keys: (state) => [
      { press: "↑ ↓", does: "alternative", group: "move", brief: true },
      { press: "← →", does: "alternative", group: "move", brief: true },
      ...looking,
      theseKeys,
      { press: "⏎", does: "take this one", short: "take", group: "choose", brief: true },
      { press: "a", does: "actions", group: "consult" },
      { press: "s", does: "suggestions", group: "consult" },
      ...actions,
      { press: "q esc", does: "quit", group: "finish", brief: true },
    ],
  },
  {
    // Last, and the only one that always matches: whichever view is showing,
    // named so a short list cannot be mistaken for a broken one.
    id: "graph",
    title: (state) => `the ${state.view} view`,
    when: () => true,
    keys: onTheGraph,
  },
];

/** Where the reader is. The list is ordered most specific first. */
export function screenFor(state: KeyState): Screen {
  return SCREENS.find((screen) => screen.when(state)) ?? SCREENS[SCREENS.length - 1]!;
}

/** The screen's keys in the order they are drawn, each group once. */
export function groupedKeys(screen: Screen, state: KeyState): { group: string; keys: Key[] }[] {
  const order: string[] = [];
  const byGroup = new Map<string, Key[]>();
  for (const key of screen.keys(state)) {
    if (!byGroup.has(key.group)) {
      byGroup.set(key.group, []);
      order.push(key.group);
    }
    byGroup.get(key.group)!.push(key);
  }
  return order.map((group) => ({ group, keys: byGroup.get(group)! }));
}

/**
 * Rows the guide will draw, so the pane budget can be arithmetic.
 *
 * `compact` drops the group headings. A short window would otherwise clip the
 * last groups off the bottom, and a half-listed set of keys is the one thing
 * this guide must never be: a key cut off reads exactly like a key that does not
 * exist.
 */
export function keyRows(screen: Screen, state: KeyState, compact = false): number {
  return groupedKeys(screen, state).reduce(
    (rows, each) => rows + (compact ? 0 : 1) + each.keys.length,
    1,
  );
}

/**
 * The one line along the bottom: the few worth naming without being asked.
 *
 * Per screen like everything else, so it can no longer describe a key that does
 * nothing where you are standing.
 */
export function briefKeys(screen: Screen, state: KeyState): string {
  return screen
    .keys(state)
    .filter((key) => key.brief)
    .map((key) => `${key.press} ${key.short ?? key.does}`)
    .join("   ");
}
