/**
 * Headless check that the editor renders and responds.
 *
 * Renders into a capture stream and drives a fake TTY, so it runs in CI and in
 * an agent's shell where no terminal exists. It asserts the frame, the pure
 * selection functions, and the key handling. It never runs a model: the action
 * prompts are asserted as text, and `PL_TUI_PREFETCH=off` keeps the render
 * silent.
 */
import { render } from "ink";
import { PassThrough, Writable } from "node:stream";
import { loadConfig } from "../src/config.js";
import { App, cacheKey, statusColor } from "./app.js";
import { ROOT, pathsFrom, pathsThrough, pathsTo, readGraph, referencesFor, wordsFor } from "./graph.js";
import { apiAvailable, apiKey, askFor, parseEdits, parseOptions, unwrap } from "./claude.js";
import { ACTIONS, actionsFor, shapeOf, type Selection } from "./actions.js";
import { VIEWS, type TreeRow } from "./views.js";
import { idFor, sameChange, usable, type Change, type Suggestion } from "./changes.js";
import { moved, parseAnswer, parseSuggestions, promptFor, promptForAmend, promptForAsk, visibleIds } from "./suggest.js";
import { MAX_ENUMERATED, suggestionSchema } from "./schema.js";
import { groupOf, selectionRows } from "./selection.js";
import { ReviewPane, sidesOf, underReview } from "./review.js";
import { SCREENS, briefKeys, groupedKeys, keyRows, screenFor } from "./keys.js";
import { KNOWLEDGE_LEVELS } from "../src/types.js";
import { GLYPH, LEVEL, ROLE, SURFACE } from "./theme.js";
import { readFileSync } from "node:fs";
import { ERASE_SCREEN, clearOnResize } from "./terminal.js";
import { EventEmitter } from "node:events";

process.env.PL_TUI_PREFETCH = "off";

let frame = "";
// Kept per write as well as concatenated: Ink writes one whole frame per call,
// so the last chunk is the last frame, which is the only way to measure a
// frame's height without guessing where one ends and the next begins.
const frames: string[] = [];
const capture = new Writable({
  write(chunk, _encoding, callback) {
    const text = String(chunk);
    frame += text;
    frames.push(text);
    callback();
  },
});
Object.assign(capture, { columns: 130, rows: 34, isTTY: true });

/**
 * Enough of a TTY for Ink to attach `useInput` to. A real stream rather than an
 * EventEmitter because Ink 7 pulls input with `readable` and `read()`.
 */
const keyboard = new PassThrough();
Object.assign(keyboard, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const press = (sequence: string) => keyboard.write(sequence);
const DOWN = "[B";
const RIGHT = "[C";
const UP = "[A";
const LEFT = "[D";
const SHIFT_TAB = "[Z";
const TAB = "\t";
const PANE_NEXT = "]";
const ENTER = "\r";
const SPACE = " ";
const ACTION_KEY = "a";
const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

const config = await loadConfig(ROOT);
const view = await readGraph(config);

const { unmount } = render(<App config={config} initial={view} startAt="the-vocabulary-index" />, {
  stdout: capture as never,
  stdin: keyboard as never,
  patchConsole: false,
  exitOnCtrlC: false,
});
await settle();
const openingFrame = frame;

// Open on a node reached by several parents, so path cycling has something to
// cycle, then exercise each interaction in turn.
const target = "mechanism.the-vocabulary-index";
const targetPaths = pathsTo(view, target);
// startAt already put the cursor on the target, so the opening frame is it.
const atTarget = openingFrame;

let mark = frame.length;
press(RIGHT);
await settle();
const afterCycle = frame.slice(mark);

mark = frame.length;
press(TAB);
await settle();
const afterView = frame.slice(mark);

mark = frame.length;
press(PANE_NEXT);
await settle();
const afterTab = frame.slice(mark);

mark = frame.length;
press(DOWN);
await settle();
press(DOWN);
await settle();
const afterScroll = frame.slice(mark);

mark = frame.length;
press(PANE_NEXT);
await settle();
press(PANE_NEXT); // back around to the graph
await settle();
press(ACTION_KEY);
await settle();
const afterMenu = frame.slice(mark);
unmount();

const plainOf = (text: string) => text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
const failures: string[] = [];
const check = (label: string, ok: boolean) => {
  if (!ok) failures.push(label);
};

// --- graph -----------------------------------------------------------------
check("graph has nodes", view.byId.size > 0);
check("references loaded", view.references.length > 0);

// --- paths -----------------------------------------------------------------
const root = "audience.role.engineer";
check("a root node is its own path", JSON.stringify(pathsTo(view, root)) === `[["${root}"]]`);
const deep = "mechanism.the-digest-derivation";
const deepPaths = pathsTo(view, deep);
// A path starts wherever `constrainedBy` runs out, which is the context level
// here: audience is shaped unlike the others and does not constrain context.
check(
  "every path starts at a node nothing constrains",
  deepPaths.every((p) => (view.parents.get(p[0])?.size ?? 0) === 0),
);
check("every path ends at the node asked for", deepPaths.every((p) => p.at(-1) === deep));
check(
  "every step of a path is constrained by the step before it",
  deepPaths.every((p) => p.every((id, i) => i === 0 || view.parents.get(id)?.has(p[i - 1]))),
);

// --- a path runs top to bottom, not root-to-here ----------------------------
// Stopping at the focused node drew a node with two children as having none.
const middle = "context.a-new-decision-cannot-be-fitted-to-the-old-ones";
check("the sample node really has children", (view.children.get(middle)?.size ?? 0) > 0);
check("...and no parents, so root-to-here would be just itself", (view.parents.get(middle)?.size ?? 0) === 0);
check("pathsTo alone would show it alone", pathsTo(view, middle).every((p) => p.length === 1));
const through = pathsThrough(view, middle);
check("a path through it reaches past it", through.every((p) => p.length > 1));
check("every path through it contains it", through.every((p) => p.includes(middle)));
check(
  "every path through it ends at a node with no children",
  through.every((p) => (view.children.get(p.at(-1)!)?.size ?? 0) === 0),
);
check(
  "every path through it starts at a node with no parents",
  through.every((p) => (view.parents.get(p[0]!)?.size ?? 0) === 0),
);
check(
  "every step of a path through is constrained by the step before it",
  through.every((p) => p.every((id, i) => i === 0 || view.parents.get(id)?.has(p[i - 1]!))),
);
check("pathsFrom stops at a leaf", pathsFrom(view, target).every((p) => p.length === 1));

// --- panes filter to the path ----------------------------------------------
const digestRefs = referencesFor(view, deepPaths[0]);
check("the digest path finds its mistake", digestRefs.some((r) => r.id.includes("digest")));
check(
  "the digest path does not pull in the unrelated word mistake",
  !digestRefs.some((r) => r.id.includes("one-word-named-two-things")),
);
check(
  "the vocabulary path finds its own mistake",
  referencesFor(view, pathsTo(view, "behavior.two-meanings-for-one-name-refuse-the-commit")[0]).some(
    (r) => r.id.includes("one-word-named-two-things"),
  ),
);
check("a one-node path shares no words", wordsFor(view, [root]).length === 0);
const pathWords = wordsFor(view, deepPaths[0]);
check("a longer path shares words", pathWords.length > 0);
// The pane exists to say what a word means, not merely that it recurs.
// Each kind of word carries its own kind of information, and never the other's.
check(
  "every word says something about itself",
  pathWords.every((w) => (w.declared ? Boolean(w.definition) : Boolean(w.spread))),
);
check(
  "a declared term has no spread note and an undeclared noun has no definition",
  pathWords.every((w) => (w.declared ? !w.spread : !w.definition)),
);

// A declared term shows its definition; only an undeclared noun falls back to
// the spread note. Showing the note for a declared term would be the bug.
const declaredWords = wordsFor(view, pathsTo(view, "mechanism.the-vocabulary-index")[0]).filter(
  (w) => w.declared,
);
check("the graph declares at least one term", declaredWords.length > 0);
check(
  "a declared term carries its authored definition",
  declaredWords.every((w) => (w.definition ?? "").length > 0),
);
check(
  "a declared term carries the level it was declared at",
  declaredWords.every((w) => typeof w.level === "string"),
);
check(
  "declared terms come before undeclared nouns",
  (() => {
    const all = wordsFor(view, pathsTo(view, "mechanism.the-vocabulary-index")[0]);
    const lastDeclared = all.map((w) => w.declared).lastIndexOf(true);
    const firstUndeclared = all.map((w) => w.declared).indexOf(false);
    return lastDeclared === -1 || firstUndeclared === -1 || lastDeclared < firstUndeclared;
  })(),
);
check(
  "an undeclared noun counts how far it spread",
  pathWords
    .filter((w) => !w.declared)
    .every((w) => (w.spread?.uses ?? 0) > 0 && (w.spread?.levels ?? 0) > 0),
);

// --- the five views ---------------------------------------------------------
check("there are five views", VIEWS.length === 5);
check(
  "every view has a distinct id and label",
  new Set(VIEWS.map((v) => v.id)).size === 5 && new Set(VIEWS.map((v) => v.label)).size === 5,
);

for (const lens of VIEWS) {
  for (const id of [root, deep, target]) {
    const r = lens.build(view, id, 0, id);
    check(`${lens.id} puts the focused node in its own order (${id.split(".")[0]})`, r.order.includes(id));
    check(`${lens.id} never repeats a node in its order (${id.split(".")[0]})`, new Set(r.order).size === r.order.length);
    check(`${lens.id} offers at least one selection (${id.split(".")[0]})`, r.selections >= 1);
    check(`${lens.id} hands the actions a path ending at the focus (${id.split(".")[0]})`, r.path.at(-1) === id);
    check(`${lens.id} only names nodes that exist (${id.split(".")[0]})`, r.order.every((n) => view.byId.has(n)));
  }
}

// Only path view varies with the selection; the rest ignore it, which is what
// makes left and right safe to press anywhere.
const pathLens = VIEWS.find((v) => v.id === "path")!;
check("path view offers one selection per path", pathLens.build(view, target, 0, target).selections === targetPaths.length);
check(
  "path view's selections are different paths",
  JSON.stringify(pathLens.build(view, target, 0, target).path) !==
    JSON.stringify(pathLens.build(view, target, 1, target).path),
);
for (const lens of VIEWS.filter((v) => v.id !== "path")) {
  check(
    `${lens.id} ignores the selection`,
    JSON.stringify(lens.build(view, target, 0, target).order) ===
      JSON.stringify(lens.build(view, target, 3, target).order),
  );
}

// A tree may name a node twice; the cursor order must not, and the second
// mention must be marked rather than silently drawn as another node.
const up = VIEWS.find((v) => v.id === "ascending")!.build(view, target, 0, target);
if (up.layout.kind === "tree") {
  const nodeRows = up.layout.rows.filter((r) => r.kind === "node");
  const reentries = nodeRows.filter((r) => r.kind === "node" && r.reentry);
  check("this graph really does re-enter a node", reentries.length > 0);
  check("more tree rows than unique nodes, because of the re-entries", nodeRows.length > up.order.length);
  check(
    "every re-entry names a node drawn earlier",
    reentries.every((r) => r.kind === "node" && up.order.includes(r.id)),
  );
}

// Level view shows the focus's level and its neighbours, and nothing else.
const lv = VIEWS.find((v) => v.id === "level")!.build(view, deep, 0, deep);
if (lv.layout.kind === "bands") {
  check("level view shows at most three bands", lv.layout.bands.length <= 3);
  check("exactly one band is the current one", lv.layout.bands.filter((b) => b.current).length === 1);
  check(
    "the current band is the focus's own level",
    lv.layout.bands.find((b) => b.current)?.level === view.byId.get(deep)!.level,
  );
  check("level view lights the focus and what it touches", lv.lit.includes(deep));
}

// Path view splits the alternatives in two, and the two never overlap.
const pv = pathLens.build(view, target, 0, target);
if (pv.layout.kind === "path") {
  check(
    "same parent and same level never name the same node",
    pv.layout.steps.every((step) => step.sameParent.every((id) => !step.sameLevel.includes(id))),
  );
  check(
    "no step lists itself among its own alternatives",
    pv.layout.steps.every((s) => !s.sameParent.includes(s.id) && !s.sameLevel.includes(s.id)),
  );
  check(
    "same-parent alternatives really do share the step's parent",
    pv.layout.steps.every((step, index) =>
      index === 0
        ? step.sameParent.length === 0
        : step.sameParent.every((id) => view.parents.get(id)?.has(pv.path[index - 1]!)),
    ),
  );
}

// --- every tree reads the same way down the screen ---------------------------
// Higher on the screen means closer to the audience, in all three tree views.
// The hourglass used to root both halves at the focus and let a heading say
// which way "outward" meant, so the same downward gesture meant shallower in one
// half and deeper in the other.
const forked = [...view.byId.values()].find(
  (node) => (view.parents.get(node.id)?.size ?? 0) > 0 && (view.children.get(node.id)?.size ?? 0) > 0,
)!;
for (const id of ["ascending", "descending", "hourglass"] as const) {
  const r = VIEWS.find((v) => v.id === id)!.build(view, forked.id, 0, forked.id);
  if (r.layout.kind !== "tree") continue;
  const rows = r.layout.rows.filter((row): row is Extract<TreeRow, { kind: "node" }> => row.kind === "node");
  const at = (id: string) => rows.findIndex((row) => row.id === id);
  const focusAt = at(forked.id);
  check(`${id} draws the focused node`, focusAt >= 0);

  // The invariant: nothing is drawn above the thing it rests on.
  const seenBefore = new Set<string>();
  let inverted = 0;
  for (const row of rows) {
    for (const parent of view.parents.get(row.id) ?? []) {
      if (rows.some((other) => other.id === parent) && !seenBefore.has(parent)) inverted += 1;
    }
    seenBefore.add(row.id);
  }
  check(`${id} never draws a claim above what it rests on`, inverted === 0);

  if (id !== "descending") {
    const ancestors = [...(view.parents.get(forked.id) ?? [])].filter((p) => at(p) >= 0);
    check(`${id} shows what it rests on`, ancestors.length > 0);
    check(`${id} puts what it rests on above it`, ancestors.every((p) => at(p) < focusAt));
  }
  if (id !== "ascending") {
    const children = [...(view.children.get(forked.id) ?? [])].filter((c) => at(c) >= 0);
    check(`${id} shows what rests on it`, children.length > 0);
    check(`${id} puts what rests on it below it`, children.every((c) => at(c) > focusAt));
  }

  // The counts moved to the heading now that there is one continuous tree, and
  // they name their direction in full: a bare "rests on 2" reads equally as
  // "rests on two things" and "two things rest on it".
  check(`${id} says which direction it counted`, /rests on/.test(r.caption));
  check(`${id} does not invent a word for it`, !/carries/.test(r.caption));
  check(
    `${id} cannot be read in the wrong direction`,
    /it rests on|rests on it/.test(r.caption),
  );
  check(`${id} draws no label between the cards`, r.layout.rows.every((row) => row.kind === "node"));
}

// --- a card names its level wherever position does not ----------------------
// Depth in a tree is distance from the node you are on, not stratum, so a tree
// card must say its level; the level grid must not, because its heading says it
// once for every card under it.
{
  const frameOf = (frame: string) => plainOf(frame).split("\n");
  const treeCards = frameOf(afterView).filter((l) => /[╭┏][─━]/.test(l));
  check("the tree view draws cards at all", treeCards.length > 0);
  check(
    "every tree card names its level in its border",
    treeCards.every((l) => KNOWLEDGE_LEVELS.some((lvl) => l.includes(lvl.toUpperCase()))),
  );
  const gridCards = frameOf(atTarget).filter((l) => /[╭┏][─━]/.test(l));
  check("the level view draws cards at all", gridCards.length > 0);
  check(
    "the level grid does not repeat its heading on every card",
    gridCards.every((l) => !KNOWLEDGE_LEVELS.some((lvl) => l.includes(lvl.toUpperCase()))),
  );
}

// Level view names the level directly above its own cards, never at the top of
// the column where it read as a heading for the level ABOVE it.
const levelRender = VIEWS.find((v) => v.id === "level")!.build(view, deep, 0, deep);
check("level view keeps its own heading rather than a caption", levelRender.caption !== "");
const levelFrame = atTarget;
const levelLines = plainOf(levelFrame).split("\n").map((l) => l.trim());
const headingAt = levelLines.findIndex((l) => l.startsWith("┃ MECHANISM"));
const firstCardAt = levelLines.findIndex((l) => l.includes("╭─") || l.includes("┏━"));
check("the level heading sits immediately above its cards", headingAt >= 0 && headingAt < firstCardAt);
const bandHeadingAt = levelLines.findIndex((l) => /^[┃│] architecture/.test(l));
check("the level heading is below the neighbouring list, not above it", bandHeadingAt < headingAt);
// A neighbouring list is part of the graph pane, so its rail answers the same
// question every other heading's does. These lists alone drew the light rail
// always, which made the level view the one screen where focus was invisible.
check(
  "a neighbouring band shows the pane's focus on its rail",
  levelLines[bandHeadingAt]?.startsWith(GLYPH.railOn) === true,
);

// --- a level band shows what the node is connected to ------------------------
// Alphabetical order pushed a node's own children past the cap, so a band meant
// to show lineage showed everything except it.
const bandFrame = plainOf(atTarget).split("\n").map((l) => l.trimEnd());
const archAt = bandFrame.findIndex((l) => /^\s*[┃│] architecture/.test(l));
check("the neighbouring band says how many connect", bandFrame[archAt]?.includes("connected"));
const parentStatement = view.byId.get([...(view.parents.get(target) ?? [])][0]!)!.statement;
check(
  "the node's own parent is among the rows the band shows",
  bandFrame.slice(archAt, archAt + 5).some((l) => l.includes(parentStatement.slice(0, 30))),
);
check(
  "the connected row is drawn with the heavy rail",
  bandFrame
    .slice(archAt, archAt + 5)
    .some((l) => l.includes(GLYPH.railOn) && l.includes(parentStatement.slice(0, 20))),
);

// --- every navigation key is reversible -------------------------------------
// Doing a thing and then its opposite must land you exactly where you started.
// The arrows failed this when the view was built from the node they moved: down
// re-rooted the tree, so the order changed under the press and up had nowhere to
// go. Anchor and cursor are separate now, and this is what holds them apart.
const stateAfter = async (presses: string[], startAt: string, viewPresses = 0, rows = 30) => {
  const seen: string[] = [];
  const out = new Writable({
    write(chunk, _e, cb) {
      seen.push(String(chunk));
      cb();
    },
  });
  Object.assign(out, { columns: 120, rows, isTTY: true });
  const keys = new PassThrough();
  Object.assign(keys, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const instance = render(<App config={config} initial={view} startAt={startAt} />, {
    stdout: out as never,
    stdin: keys as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();
  for (let i = 0; i < viewPresses; i++) {
    keys.write(TAB);
    await settle();
  }
  for (const press of presses) {
    keys.write(press);
    await settle();
  }
  instance.unmount();
  // The last painted frame, chosen by size rather than by looking for a word in
  // it. Filtering on "VOCABULARY" assumed that pane is always on screen, and the
  // keyboard guide can take the column — so a test that pressed `?` was handed
  // the frame from BEFORE the press and quietly asserted against the old state.
  return plainOf(seen.filter((frame) => frame.split("\n").length > 5).at(-1) ?? "");
};

// The exact case from the report: a node with a cone below it, in `down` view.
const coned = "behavior.an-unowned-file-refuses-the-commit";
check("the reported node really has a cone below it", (view.children.get(coned)?.size ?? 0) > 0);

// `coned` has one path, so right and left are correctly inert there; the
// selection cases need a node the graph reaches more than one way.
const reversible: [string, string[], string[], number, string][] = [
  ["down then up", [DOWN, DOWN], [UP, UP], 2, coned],
  ["up then down", [UP], [DOWN], 2, coned],
  ["right then left in path view", [RIGHT], [LEFT], 1, target],
  ["left then right in path view", [LEFT], [RIGHT], 1, target],
  ["pane forward then back", ["]"], ["["], 0, coned],
  ["pane back then forward", ["["], ["]"], 0, coned],
];
for (const [label, forth, back, views, from] of reversible) {
  const rest = await stateAfter([], from, views);
  const moved = await stateAfter(forth, from, views);
  const returned = await stateAfter([...forth, ...back], from, views);
  check(`${label} actually changes something`, moved !== rest);
  check(`${label} returns to where it started`, returned === rest);
}

// Tab all the way round the cycle is the same screen again, and so is tab then
// shift-tab — which means the switch may not quietly reset selection or scroll.
const home = await stateAfter([], coned, 0);
check("tab five times comes back to the same view", (await stateAfter([TAB, TAB, TAB, TAB, TAB], coned, 0)) === home);
check("tab then shift-tab comes back", (await stateAfter([TAB, SHIFT_TAB], coned, 0)) === home);

// Enter has no inverse on purpose: it is a decision, like committing an
// alternative, so it is a key rather than something an arrow does by accident.
check(
  "enter re-anchors the view on the cursor",
  (await stateAfter([DOWN, ENTER], coned, 2)) !== (await stateAfter([DOWN], coned, 2)),
);

// --- the cursor is obvious, and it is obvious the same way everywhere --------
// On a selected path every card is amber and bold, so hue and emphasis are both
// spent; the gutter is the only channel left that can say "and this one is where
// you are". It has to mean that in every view, and only ever once.
// The mark runs down every row of one card, so count runs of marked lines, not
// marked lines: one run means one card wears it.
const markedRuns = (frame: string) => {
  const marked = plainOf(frame)
    .split("\n")
    .map((line) => line.includes(GLYPH.here));
  return marked.filter((on, index) => on && !marked[index - 1]).length;
};
for (const views of [0, 1, 2, 3, 4]) {
  const runs = markedRuns(await stateAfter([], target, views));
  check(`view ${views} marks exactly one card as the cursor's (${runs})`, runs === 1);
}
check(
  "moving the cursor moves the mark rather than adding one",
  markedRuns(await stateAfter([DOWN], target, 2)) === 1,
);

// --- the selection, and what it is asked about ------------------------------
// The suggestion prompt is the repository's own NODE_SHAPE, so the editor cannot
// drift from the rule it is applying.
const picked = ["product.one-name-has-one-meaning", "product.a-defined-word-used-as-prose-is-reported"];
const askedFor = promptFor(view, picked);
check("the prompt carries the repository's own shape rule", askedFor.includes("do not overlap"));
check("the prompt carries the style rule for anything it writes", askedFor.includes("ASD-STE100"));
check("the prompt shows the picked nodes", picked.every((id) => askedFor.includes(id)));
check("the prompt shows what else is at their level", askedFor.includes("everything else at product"));
check("the prompt names the levels in order", askedFor.includes("audience, context, product"));

// A changeset speaks the graph's own words for a change, not create/update/delete.
const reply = JSON.stringify({
  suggestions: [
    {
      title: "merge the two",
      changes: [
        { kind: "restated", id: picked[0], statement: "One name has one meaning, and the system says so." },
        { kind: "withdrawn", id: picked[1] },
        { kind: "regoverned", id: picked[0], constrainedBy: ["context.one-word-carries-two-meanings"] },
        { kind: "added", level: "behavior", statement: "When two names collide the system refuses.", constrainedBy: [picked[0]] },
      ],
    },
  ],
});
const parsed = parseSuggestions(view, reply);
check("a suggestion parses", parsed.length === 1 && parsed[0]!.changes.length >= 3);
check("a suggestion carries prose for the reviewer", typeof parsed[0]!.summary === "string" && parsed[0]!.summary.length > 0);

// A change that changes nothing is not a change. Asked for three suggestions the
// model pads, and a restatement to the words already there is the cheapest
// padding — it reached the reviewer as a `−` and a `+` holding one sentence.
const standing = view.byId.get(picked[0]!)!;
check(
  "restating a claim to the words it already has is refused",
  usable(view, [{ kind: "restated", id: standing.id, statement: standing.statement }]).length === 0,
);
check(
  "restating it to different words is not",
  usable(view, [{ kind: "restated", id: standing.id, statement: "Something else entirely." }]).length === 1,
);
check(
  "regoverning a claim to the parents it already has is refused",
  usable(view, [
    { kind: "regoverned", id: standing.id, constrainedBy: [...standing.constrainedBy] },
  ]).length === 0,
);
check(
  "every change kind is one the graph already names",
  parsed[0]!.changes.every((c) => ["restated", "withdrawn", "regoverned", "added"].includes(c.kind)),
);

// Invented ids and levels are dropped rather than half written.
const invented: Change[] = [
  { kind: "restated", id: "product.not-a-node", statement: "x" },
  { kind: "regoverned", id: picked[0]!, constrainedBy: ["context.not-a-node"] },
  { kind: "added", level: "nowhere" as never, statement: "x", constrainedBy: [] },
  { kind: "added", level: "product", statement: "", constrainedBy: [] },
];
check("a change naming nothing is refused", usable(view, invented).length === 0);

// A Context's parent may be an audience SET, which is not a node. Reading only
// `byId` called every context node in this graph invalid; refusing an empty list
// everywhere called every audience node invalid. Both made the editor stricter
// than the linter, which is the one way it must not differ.
const context = [...view.byId.values()].find((node) => node.level === "context")!;
const audience = [...view.byId.values()].find((node) => node.level === "audience")!;
check("the sample context node really names an audience set", context.constrainedBy.some((p) => p.endsWith(".*")));
check(
  "an audience set is a parent a change may name",
  usable(view, [
    { kind: "added", level: "context", statement: "An engineer loses a decision.", constrainedBy: ["audience.role.*"] },
  ]).length === 1,
);
check(
  "a set with no values is still refused",
  usable(view, [
    { kind: "added", level: "context", statement: "An engineer loses a decision.", constrainedBy: ["audience.nosuchset.*"] },
  ]).length === 0,
);
check(
  "an audience claim may be governed by nothing",
  usable(view, [{ kind: "added", level: "audience", statement: "The product serves someone.", constrainedBy: [] }]).length === 1,
);
check(
  "every other level may not",
  usable(view, [{ kind: "added", level: "context", statement: "An engineer loses a decision.", constrainedBy: [] }]).length === 0,
);

// Measured against the real model: a reply omitting constrainedBy, or naming a
// kind the graph has no word for, used to come back through here as a thrown
// error or as a change `apply` would write. The guard has to answer for a
// reply it did not get to dictate, so every field is read through a check.
const malformed = [
  { kind: "added", level: "product", statement: "A claim states one thing." },
  { kind: "regoverned", id: picked[0]! },
  { kind: "restated", id: picked[0]! },
  { kind: "deleted", id: picked[0]! },
  { kind: "added", level: "product", statement: "x", constrainedBy: "not a list" },
  null,
] as unknown as Change[];
check(
  "a reply missing a field is refused rather than thrown out of",
  (() => {
    try {
      return usable(view, malformed).length === 0;
    } catch {
      return false;
    }
  })(),
);
check(
  "a reply whose every change is unusable answers with nothing to do",
  parseSuggestions(view, JSON.stringify({ suggestions: [{ title: "t", summary: "s", changes: invented }] })).length === 0,
);
check(
  "a reply that is not about suggestions at all is still refused",
  (() => {
    try {
      parseSuggestions(view, JSON.stringify({ nonsense: true }));
      return false;
    } catch {
      return true;
    }
  })(),
);

// A reply that cannot be read is asked again, carrying the reason it failed.
{
  const asked: string[] = [];
  const truncated = JSON.stringify({ suggestions: [{ title: "t", changes: [] }] }).slice(0, 20);
  const good = await askFor(
    "the original prompt",
    (raw) => parseSuggestions(view, raw),
    3,
    async (prompt) => {
      asked.push(prompt);
      return asked.length === 1 ? truncated : reply;
    },
  );
  check("a reply that cannot be read is asked again", asked.length === 2);
  check("the retry keeps the original prompt", asked[1]!.startsWith("the original prompt"));
  check("the retry says what was wrong with the last reply", asked[1]!.includes("could not be used"));
  check("the second reply is the one used", good.length === 1);
}
check(
  "a prompt that never answers gives up rather than asking forever",
  await (async () => {
    let calls = 0;
    try {
      await askFor("p", () => { throw new Error("no"); }, 3, async () => { calls += 1; return ""; });
      return false;
    } catch {
      return calls === 3;
    }
  })(),
);

// The schema is built from the graph, so the derived id has nowhere to go.
{
  const schema = suggestionSchema(view, visibleIds(view, picked)) as any;
  const change = schema.properties.suggestions.items.properties.changes.items;
  const byKind = new Map<string, any>(
    change.anyOf.map((each: any) => [each.properties.kind.const, each]),
  );
  check("the schema offers exactly the four kinds the graph names", byKind.size === 4);
  check(
    "every kind the changeset has is in the schema",
    ["restated", "regoverned", "added", "withdrawn"].every((kind) => byKind.has(kind)),
  );
  const restatedIds = byKind.get("restated").properties.id.enum;
  check("a restated id is an enumeration, not a string", Array.isArray(restatedIds));
  const shown = visibleIds(view, picked);
  check("that enumeration is what the prompt showed, not the whole graph", restatedIds.length < view.byId.size);
  check(
    "every id in it is a node that exists",
    restatedIds.every((id: string) => view.byId.has(id)),
  );
  check(
    "every id in it is one the prompt named",
    restatedIds.every((id: string) => shown.includes(id)),
  );
  check(
    "the derived id that was measured is not in it",
    !restatedIds.includes("context.a-rejected-option-is-lost-within-days-why"),
  );
  // A change acts on a node; a parent may be an audience SET. The two lists
  // differ, and conflating them let a suggestion propose restating a wildcard.
  check(
    "a wildcard is not something a change can act on",
    !restatedIds.some((id: string) => id.endsWith(".*")),
  );
  check("the enumeration stays under the compiler's ceiling", restatedIds.length <= MAX_ENUMERATED);

  // A Context's parent is an audience SET, so the wildcard has to be offered
  // where a Context is picked — otherwise the model cannot name the one parent
  // every context node in this graph actually has.
  const contextPick = [...view.byId.values()].filter((n) => n.level === "context").slice(0, 2).map((n) => n.id);
  const contextSchema = suggestionSchema(view, visibleIds(view, contextPick)) as any;
  const contextChange = contextSchema.properties.suggestions.items.properties.changes.items;
  const asParent = contextChange.anyOf[1].properties.constrainedBy.items.enum;
  const asTarget = contextChange.anyOf[1].properties.id.enum;
  check("a wildcard is offered where a parent goes", asParent.some((id: string) => id.endsWith(".*")));
  check("...and not where a node goes", !asTarget.some((id: string) => id.endsWith(".*")));
  check("a context pick also fits the ceiling", asParent.length <= MAX_ENUMERATED);
  check(
    "an added claim carries no id, because one is derived for it",
    byKind.get("added").properties.id === undefined,
  );
  check(
    "an added level is the graph's own list of levels",
    JSON.stringify(byKind.get("added").properties.level.enum) === JSON.stringify(KNOWLEDGE_LEVELS),
  );
  // Structured outputs refuses a schema that leaves an object open.
  const objects: any[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (node.type === "object") objects.push(node);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(schema);
  check("every object in the schema is closed", objects.every((o) => o.additionalProperties === false));
  check("every object in the schema says what it requires", objects.every((o) => Array.isArray(o.required)));
  check("the schema has objects to check at all", objects.length >= 6);
}

// New ids come from the statement and never collide with one already there.
const taken = new Set(view.byId.keys());
const fresh = idFor("product", "The system names the claims that a change added", taken);
check("a new id is derived from its statement", fresh.startsWith("product.the-system-names"));
check("a new id does not collide", !taken.has(fresh));
check(
  "a second node with the same statement gets a distinct id",
  idFor("product", "same words here", new Set(["product.same-words-here"])) !== "product.same-words-here",
);

// --- selection-typed actions ------------------------------------------------
const nodeSel: Selection = { view, node: view.byId.get(root)!, path: [root] };
const pathSel: Selection = { view, node: view.byId.get(target)!, path: targetPaths[0] };
check("a lone node is node-shaped", shapeOf(nodeSel) === "node");
check("a chain is path-shaped", shapeOf(pathSel) === "path");
check(
  "percolate is offered only for a path",
  !actionsFor(nodeSel).some((a) => a.id === "percolate") &&
    actionsFor(pathSel).some((a) => a.id === "percolate"),
);
check("reword is offered for both", ["reword"].every((id) =>
  [nodeSel, pathSel].every((s) => actionsFor(s).some((a) => a.id === id)),
));

// The point of selection typing: one key, a different question by shape.
const critique = ACTIONS.find((a) => a.id === "critique")!;
const nodeCritique = critique.prompt(nodeSel);
const pathCritique = critique.prompt(pathSel);
check("critique asks a different question of a node than of a path", nodeCritique !== pathCritique);
check("critique of a lone node says nothing constrains it", nodeCritique.includes("nothing does"));
check("critique of a path asks what stops following", pathCritique.includes("does not follow"));
check(
  "a node critique wants options and a path critique wants edits",
  nodeCritique.includes("JSON array") && pathCritique.includes('"edits"'),
);
check(
  "every prompt carries the repository's own style rule",
  ACTIONS.every((a) =>
    a.prompt(pathSel).includes("ASD-STE100 Simplified Technical English"),
  ),
);
check(
  "percolate names how many statements it would bring into line",
  ACTIONS.find((a) => a.id === "percolate")!.hint(pathSel).includes(String(targetPaths[0].length - 1)),
);

// --- parsing ----------------------------------------------------------------
check("parses a bare array", JSON.stringify(parseOptions('["a","b","c"]')) === '["a","b","c"]');
check(
  "parses the CLI result envelope",
  JSON.stringify(parseOptions(JSON.stringify({ result: '["a","b","c"]' }))) === '["a","b","c"]',
);
check(
  "parses a fenced array inside an envelope",
  JSON.stringify(parseOptions(JSON.stringify({ result: '```json\n["a","b","c"]\n```' }))) ===
    '["a","b","c"]',
);
check("unwrap passes through plain text", unwrap("hello") === "hello");
check(
  "parses an edit set",
  parseEdits('{"edits":[{"id":"a","statement":"x"}]}')[0].statement === "x",
);
check(
  "an edit set drops entries with no statement",
  parseEdits('{"edits":[{"id":"a","statement":"x"},{"id":"b"}]}').length === 1,
);
for (const [label, bad] of [
  ["no array", "sorry, I cannot"],
  ["an empty array", "[]"],
] as const) {
  check(`refuses ${label}`, (() => {
    try {
      parseOptions(bad);
      return false;
    } catch {
      return true;
    }
  })());
}
check(
  "refuses an edit set with nothing in it",
  (() => {
    try {
      parseEdits('{"edits":[]}');
      return false;
    } catch {
      return true;
    }
  })(),
);

// A cache key must change with the statement, the path, and the action, or one
// answer would be served for a different question.
const someNode = view.byId.get(deep)!;
check(
  "the cache key follows the statement",
  cacheKey("reword", someNode, [deep]) !==
    cacheKey("reword", { ...someNode, statement: "different" }, [deep]),
);
check(
  "the cache key follows the action",
  cacheKey("reword", someNode, [deep]) !== cacheKey("critique", someNode, [deep]),
);
check(
  "the cache key follows the path",
  cacheKey("reword", someNode, [deep]) !== cacheKey("reword", someNode, ["other", deep]),
);

// --- frame ------------------------------------------------------------------
check("frame is non-empty", frame.length > 0);
// The graph pane's title is now the view's caption — in level view, the level.
check(
  "frame shows all three pane titles",
  ["MECHANISM", "VOCABULARY", "REFERENCES"].every((t) => frame.includes(t)),
);
check("frame shows the status footer", frame.includes(view.status));
check("frame paints the level ramp", frame.includes(hex(LEVEL.mechanism)));
check("frame paints the selection accent", frame.includes(hex(ROLE.selected)));
check("no model call ran while prefetching was off", !frame.includes("reword…"));

// The side panes must spend their space on content, not reserve it. A pane that
// truncates a sentence while sitting in empty rows is the bug this guards.
// A definition is authored content and must be shown whole; the finding about
// undeclared words is grouped under one heading rather than repeated per word.
// Fragments, not a sentence: the definition wraps across rows, so any phrase
// long enough to cross a line break would fail on the newline rather than on
// the thing being tested.
check(
  "a declared term's definition is shown",
  atTarget.includes("pair of asterisks"),
);
check(
  "the definition runs to its end rather than being cut off",
  atTarget.includes("statement."),
);
check("the undeclared words sit under one heading", atTarget.includes("no term defines"));
check(
  "the finding is not repeated once per word",
  (atTarget.match(/no term defines/g) ?? []).length === 1,
);

// --- the design system holds ------------------------------------------------
// Two rules: no meaning has two colours, and no colour has two meanings. Both
// are only real if something checks them.
const palette = [...Object.entries(LEVEL), ...Object.entries(ROLE)];
const byColour = new Map<string, string[]>();
for (const [name, value] of palette) {
  byColour.set(value, [...(byColour.get(value) ?? []), name]);
}
const shared = [...byColour.entries()].filter(([, names]) => names.length > 1);
check(
  `no colour carries two meanings (${shared.map(([c, n]) => `${c}=${n.join("/")}`).join(", ") || "none"})`,
  shared.length === 0,
);
check(
  "the level ramp and the role colours are disjoint",
  new Set([...Object.values(LEVEL), ...Object.values(ROLE)]).size ===
    Object.keys(LEVEL).length + Object.keys(ROLE).length,
);
check("every level has a colour", Object.keys(LEVEL).length === 6);

// A colour invented at a call site is a meaning nobody wrote down, so the theme
// is the only file allowed to contain one.
const sources = ["app.tsx", "main.tsx", "graph.ts", "actions.ts", "claude.ts", "terminal.ts"];
const strays = sources.filter((file) =>
  /#[0-9a-fA-F]{6}\b/.test(readFileSync(new URL(file, import.meta.url), "utf8")),
);
check(`no colour is defined outside the theme (${strays.join(", ") || "none"})`, strays.length === 0);

// Glyphs carry structure, so a glyph meaning two things is the same defect.
const glyphs = Object.values(GLYPH);
check("no glyph carries two meanings", new Set(glyphs).size === glyphs.length);

// --- the same meaning is painted the same way on every surface ---------------
// An injective palette only says no colour has two meanings. This is the other
// half: two surfaces that mean the same thing must share a colour, across every
// screen, or the system is only consistent by accident.
const roleValues = new Set<string>(Object.values(ROLE));
check(
  "every surface paints a declared role",
  Object.values(SURFACE).every((value) => roleValues.has(value)),
);

const sameMeaning: [string, string[]][] = [
  ["what you have pointed at", [
    "graph.rail.onPath",
    "graph.cursor",
    "graph.statement.onPath",
    "breadcrumb.rail",
  ]],
  ["something is wrong", ["status.blocked", "reference.kind.mistake", "action.failed"]],
  ["the state you want", ["status.complete", "edit.becomes"]],
];
for (const [meaning, surfaces] of sameMeaning) {
  const colours = new Set(surfaces.map((name) => SURFACE[name as keyof typeof SURFACE]));
  check(`"${meaning}" is one colour on all ${surfaces.length} of its surfaces`, colours.size === 1);
}
// ...and the three meanings do not bleed into each other.
check(
  "the meanings are painted differently from one another",
  new Set(sameMeaning.map(([, s2]) => SURFACE[s2[0] as keyof typeof SURFACE])).size ===
    sameMeaning.length,
);

// Call sites must name a surface. Reaching for ROLE directly is how a fourth
// meaning for an existing colour gets in without anyone reviewing it.
const appSource = readFileSync(new URL("app.tsx", import.meta.url), "utf8");
check("no screen reaches past the surface table to a raw role", !/\bROLE\./.test(appSource));

// Incomplete is not wrong: the graph's own claim is that an incomplete graph
// does not block work, and the CLI gives it its own exit code.
check(
  "a complete graph paints as settled",
  statusColor({ complete: true, blocked: false }) === SURFACE["status.complete"],
);
check(
  "an invalid or stale graph paints as a problem",
  statusColor({ complete: false, blocked: true }) === SURFACE["status.blocked"],
);
check(
  "a graph that is merely owed paints as neither",
  statusColor({ complete: false, blocked: false }) === undefined,
);
check("this graph reports its own blocked state", typeof view.blocked === "boolean");

// --- keys -------------------------------------------------------------------
// Three words, because a card is narrow and wraps: any longer fragment fails on
// the line break rather than on the thing being tested.
const focusOpening = view.byId.get(target)!.statement.split(" ").slice(0, 3).join(" ");
check("startAt opened on the node asked for", openingFrame.includes(focusOpening));
// The focused card is the only one drawn with a heavy border, so its presence
// proves the grid scrolled to keep the focus in view.
check("level view scrolled its card grid to the focused node", openingFrame.includes("┏"));
// The bar names every view and nothing else; the caption lives with the nodes.
check(
  "the view bar lists every view",
  plainOf(openingFrame).includes("level  path  down  up  hourglass"),
);
check("the view bar carries no caption", !/hourglass\s+\S/.test(plainOf(openingFrame).split("\n")[0] ?? ""));
check("the app opens in level view", openingFrame.includes("MECHANISM"));
check("arrows repainted the screen", atTarget.length > 0);
check("the target is reached by several parents", targetPaths.length > 1);
check("level view names the level it is showing", atTarget.includes("MECHANISM"));
check(
  "the vocabulary pane filled in with the path's shared words",
  wordsFor(view, targetPaths[0]).some((w) => atTarget.includes(w.name)),
);

// Level view offers one selection, so right is inert there. Path view is where
// the selections live, and it is one tab away.
check("right in a single-selection view changes nothing", afterCycle.length === 0 || !afterCycle.includes("2/"));
// Match the breadcrumb's own separator. This looked for "→" long after the
// breadcrumb switched to "›", so it returned "" and every comparison of two
// empty strings passed without testing anything.
// Match the breadcrumb's own separator. This looked for an arrow long after
// the breadcrumb switched to "›", so it returned "" and every comparison of
// two empty strings passed without testing anything.
const breadcrumb = (text: string) =>
  (plainOf(text).match(/^\s*┃ .*›.*$/m) ?? [""])[0].trim();
// Guard the guard: an empty breadcrumb would make every comparison below pass
// without comparing anything.
check("the breadcrumb helper actually finds a breadcrumb", breadcrumb(atTarget).length > 0);
check("tab switched to the next view", afterView.includes("PATH"));
check("switching view kept the focused node", afterView.includes(focusOpening));

check("a bracket repainted the screen", afterTab.length > 0);
check(
  "scrolling a side pane never moved the graph cursor",
  breadcrumb(afterScroll) === "" || breadcrumb(afterScroll) === breadcrumb(afterView),
);

// A frame taller than the window scrolls its own top away and strands
// fragments that nothing clears. This is the resize-ghosting bug as an assertion.
const plain = (text: string) => text.replace(/\u001B\[[0-9;]*[A-Za-z]/g, "");
const paints = frames.filter((f) => f.includes("VOCABULARY")).map((f) => plain(f).split("\n").length);
check("the app painted frames", paints.length > 0);
check(
  `no frame is taller than the 34-row window (tallest ${Math.max(...paints)})`,
  Math.max(...paints) <= 34,
);

// A frame taller than its window scrolls its own top away and strands fragments
// that nothing clears — the ghosting a resize produced. Check the whole range of
// window sizes, because the overflow came from per-pane rounding that only bites
// at some heights.
const heightAt = async (columns: number, rows: number, keystrokes: string[] = []) => {
  const seen: string[] = [];
  const out = new Writable({
    write(chunk, _e, cb) {
      seen.push(String(chunk));
      cb();
    },
  });
  Object.assign(out, { columns, rows, isTTY: true });
  const keys = new PassThrough();
  Object.assign(keys, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const instance = render(<App config={config} initial={view} startAt={target} />, {
    stdout: out as never,
    stdin: keys as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();
  for (const key of keystrokes) {
    keys.write(key);
    await settle();
  }
  instance.unmount();
  const last = seen.filter((f) => f.includes("VOCABULARY")).at(-1) ?? "";
  return plain(last).split("\n").filter((line) => line.length > 0).length;
};

const sizes = [
  [80, 16],
  [90, 20],
  [100, 24],
  [120, 30],
  [158, 48],
  [200, 60],
] as const;

const overflows: string[] = [];
for (const [columns, rows] of sizes) {
  const height = await heightAt(columns, rows);
  if (height > rows) overflows.push(`${columns}x${rows} painted ${height}`);
}
check(`every window size fits its frame (${overflows.join("; ") || "all fit"})`, overflows.length === 0);

// The panel the picked set draws costs rows, and the panes have to pay for
// them. They did not: the frame grew past the bottom on every pick, scrolling
// its own top away. Checked WITH nodes picked, because that is the only state
// in which it was ever wrong.
const picking = [SPACE, DOWN, SPACE, DOWN, SPACE, DOWN, SPACE];
const pickedOverflows: string[] = [];
for (const [columns, rows] of sizes) {
  const height = await heightAt(columns, rows, picking);
  if (height > rows) pickedOverflows.push(`${columns}x${rows} painted ${height}`);
}
check(
  `every window size still fits once nodes are picked (${pickedOverflows.join("; ") || "all fit"})`,
  pickedOverflows.length === 0,
);

// --- resizing must not leave the old frame underneath the new one -----------
// Ink erases on the way narrower but not on the way wider, so a widened window
// keeps a narrow frame stranded above. Replay a real resize and check.
const resizeRun = async (from: [number, number], to: [number, number], guard: boolean) => {
  const writes: string[] = [];
  const out = new Writable({
    write(chunk, _e, cb) {
      writes.push(String(chunk));
      cb();
    },
  });
  Object.assign(out, { columns: from[0], rows: from[1], isTTY: true });
  const keys = new PassThrough();
  Object.assign(keys, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  if (guard) clearOnResize(out as never);
  const instance = render(<App config={config} initial={view} startAt={target} />, {
    stdout: out as never,
    stdin: keys as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();
  const before = writes.length;
  Object.assign(out, { columns: to[0], rows: to[1] });
  (out as unknown as EventEmitter).emit("resize");
  await settle();
  instance.unmount();
  return writes.slice(before).join("");
};

const widened = await resizeRun([100, 30], [158, 48], true);
check("widening repaints", widened.includes("VOCABULARY"));
check(
  "widening erases the old frame before repainting",
  widened.indexOf(ERASE_SCREEN) !== -1 &&
    widened.indexOf(ERASE_SCREEN) < widened.indexOf("VOCABULARY"),
);

// The guard has to run ahead of Ink's own resize handler, or it would wipe the
// frame Ink just drew instead of the one before it.
const unguarded = await resizeRun([100, 30], [158, 48], false);
check(
  "without the guard nothing erases first, which is the bug",
  !unguarded.includes(ERASE_SCREEN),
);

const narrowed = await resizeRun([158, 48], [100, 30], true);
check("narrowing still repaints", narrowed.includes("VOCABULARY"));

// Writing control codes into a pipe would corrupt whatever reads it.
const piped: string[] = [];
const notATty = new Writable({
  write(chunk, _e, cb) {
    piped.push(String(chunk));
    cb();
  },
});
Object.assign(notATty, { columns: 80, rows: 24, isTTY: false });
clearOnResize(notATty as never);
(notATty as unknown as EventEmitter).emit("resize");
check("a non-TTY is never sent an erase", piped.length === 0);

// The alternate screen is what makes a resize a repaint instead of a scroll.
// Confirm the option actually engages rather than being silently ignored.
const altWrites: string[] = [];
const altOut = new Writable({
  write(chunk, _e, cb) {
    altWrites.push(String(chunk));
    cb();
  },
});
Object.assign(altOut, { columns: 100, rows: 30, isTTY: true });
const altKeys = new PassThrough();
Object.assign(altKeys, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
const altInstance = render(<App config={config} initial={view} startAt={target} />, {
  stdout: altOut as never,
  stdin: altKeys as never,
  patchConsole: false,
  exitOnCtrlC: false,
  alternateScreen: true,
});
await settle();
altInstance.unmount();
const altText = altWrites.join("");
check("the alternate screen is entered", altText.includes("[?1049h"));
check("the alternate screen is left on exit", altText.includes("[?1049l"));

// --- the alternatives pane --------------------------------------------------
// Path view shows nodes the path passed over. They are worth moving to, but
// walking onto one by accident would rebuild the whole path, so they live in
// their own pane: browse freely, commit with enter.
const pathRender = pathLens.build(view, target, 0, target);
check("path view offers alternatives", pathRender.aside.length > 0);
check(
  "the alternatives are the focused step's, not the whole path's",
  pathRender.layout.kind === "path" &&
    JSON.stringify(pathRender.aside) ===
      JSON.stringify([
        ...pathRender.layout.steps.at(-1)!.sameParent,
        ...pathRender.layout.steps.at(-1)!.sameLevel,
      ]),
);
check(
  "no alternative is the focused node itself",
  !pathRender.aside.includes(target),
);
for (const lens of VIEWS.filter((v) => v.id !== "path")) {
  check(`${lens.id} offers no alternatives, so it keeps three panes`, lens.build(view, target, 0, target).aside.length === 0);
}

const driveWide = async (presses: string[]) => driveSized(presses, 190, 34);
const drive = async (presses: string[]) => driveSized(presses, 120, 30);
const driveSized = async (presses: string[], columns: number, rows: number) => {
  const startAt = target;
  const seen: string[] = [];
  const out = new Writable({
    write(chunk, _e, cb) {
      seen.push(String(chunk));
      cb();
    },
  });
  Object.assign(out, { columns, rows, isTTY: true });
  const keys = new PassThrough();
  Object.assign(keys, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  const instance = render(<App config={config} initial={view} startAt={startAt} />, {
    stdout: out as never,
    stdin: keys as never,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  await settle();
  for (const press of presses) {
    keys.write(press);
    await settle();
  }
  instance.unmount();
  return seen.filter((f) => f.includes("VOCABULARY")).at(-1) ?? "";
};

const onAlternatives = await drive([TAB, "]"]);
check("the bracket reaches the alternatives pane in path view", onAlternatives.includes("ALTERNATIVES"));
// The alternatives column now shows one node at a time as a full card, so the
// mark is the heavy border and a heading that counts the position.
check(
  "the alternatives column names what the card is to the step",
  /SIBLING|COUSIN/.test(plainOf(onAlternatives)),
);
check("the current alternative is drawn as a card", plainOf(onAlternatives).includes("┏"));

const committed = await drive([TAB, "]", DOWN, ENTER]);
check("enter left the alternatives pane", !committed.includes("ALTERNATIVES"));
check(
  "enter rebuilt the view around the chosen node",
  breadcrumb(committed) !== "" && breadcrumb(committed) !== breadcrumb(onAlternatives),
);

// Browsing must not move anything until you commit.
check(
  "moving inside the alternatives pane does not change the path",
  breadcrumb(await drive([TAB, "]", DOWN, DOWN])) === breadcrumb(await drive([TAB])),
);

// --- a path card says which level it is -------------------------------------
// On a selected path every card wears the selection colour, which paints over
// the level ramp; without a written label there is no level signal left.
const pathFrame = plainOf(await drive([TAB]));
// Not "all six levels appear" — a tall path scrolls, so only some are drawn.
// The invariant is that every card drawn carries its level.
const cardTops = (pathFrame.match(/[╭┏]/g) ?? []).length;
const labelled = (pathFrame.match(/[╭┏][─━][─━] [A-Z]+…? /g) ?? []).length;
check(`every card in path view names its level (${labelled}/${cardTops})`, cardTops === labelled);
check("more than one level is named", new Set(pathFrame.match(/[╭┏][─━][─━] ([A-Z]+) /g) ?? []).size > 1);

// --- the arrows say what they would swap ------------------------------------
const pv2 = pathLens.build(view, target, 0, target);
if (pv2.layout.kind === "path") {
  const swaps = pv2.layout.steps.filter((s2) => s2.swapPrev || s2.swapNext);
  check("some step differs between neighbouring paths", swaps.length > 0);
  check(
    "a swap names a different node than the step it would replace",
    pv2.layout.steps.every((s2) => s2.swapPrev !== s2.id && s2.swapNext !== s2.id),
  );
  // The step that would change must really be what the next selection holds.
  const nextPath = pathsThrough(view, target)[1]!;
  check(
    "the forward swap matches the next selection",
    pv2.layout.steps.every((s2, i) => (s2.swapNext ?? nextPath[i]) === nextPath[i]),
  );
}
// Two paths means both arrows reach the same node, so there is one alternative
// and not two — drawing one card per arrow implied a choice that does not exist.
for (const id of view.byId.keys()) {
  const ways = pathsThrough(view, id);
  if (ways.length !== 2) continue;
  const twoWay = pathLens.build(view, id, 0, id);
  if (twoWay.layout.kind !== "path") continue;
  check(
    `a node reached two ways offers one alternative per step (${id.split(".")[0]})`,
    twoWay.layout.steps.every((s2) => (s2.swapPrev ?? null) === (s2.swapNext ?? null)),
  );
  break;
}

// A preview sits on the side its arrow points from, level with the card it
// would replace — they are peers at the same level, so they share its rows.
const wideFrame = plainOf(await driveWide([TAB]));
// Only card rows: the footer's key hints contain an arrow too, and they are not
// previews of anything.
const backLines = wideFrame
  .split("\n")
  .filter((line) => line.includes("←") && line.includes("│"));
check("the frame shows a swap preview", backLines.length > 0 || wideFrame.includes("→"));
check(
  "a back-arrow preview sits left of the card it would replace",
  backLines.every((line) => line.indexOf("←") < line.lastIndexOf("│")),
);
check(
  "a swap preview is a card, and names its level",
  backLines.length === 0 || /[╭][─]+ [A-Z]+ /.test(wideFrame),
);

// Every step's card is the same width and starts in the same column. Sizing the
// middle card to whatever its own previews left over made each step a different
// width, so the path zig-zagged and nothing lined up.
const cardTopLines = wideFrame
  .split("\n")
  .filter((line) => /[╭┏][─━][─━] [A-Z]+…? /.test(line));
// Group every card top by the column it starts in. The path's own cards are the
// column that recurs most — previews sit in their own columns and the
// alternatives card in another, so picking "the widest on each row" mistook one
// for a path card on rows where the path column happened to be blank.
const allTops = cardTopLines.flatMap((line) => [
  ...line.matchAll(/[╭┏][─━][─━] [A-Z]+…? [─━]+[╮┓]/g),
]);
const byColumn = new Map<number, number[]>();
for (const top of allTops) byColumn.set(top.index!, [...(byColumn.get(top.index!) ?? []), top[0].length]);
const [, pathWidths] = [...byColumn.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
check("path view drew several cards in one column", pathWidths.length > 1);
check("every path card is the same width", new Set(pathWidths).size === 1);

// --- the alternatives are paged, one whole node at a time --------------------
const alt = await drive([TAB, "]"]);
// A sibling shares the step's parent; a cousin only shares its level. Siblings
// come first, so paging runs out of siblings and then meets cousins.
const kinded = pathLens.build(view, target, 0, target);
check("every alternative is named a sibling or a cousin",
  kinded.asideKinds.length === kinded.aside.length &&
    kinded.asideKinds.every((k) => k === "sibling" || k === "cousin"));
check("siblings come before cousins",
  kinded.asideKinds.lastIndexOf("sibling") < kinded.asideKinds.indexOf("cousin") ||
    !kinded.asideKinds.includes("sibling") || !kinded.asideKinds.includes("cousin"));
check("a sibling really does share the step's parent",
  kinded.asideKinds.every((kind, i) => {
    const id = kinded.aside[i]!;
    const step = kinded.path.indexOf(target);
    const parent = step > 0 ? kinded.path[step - 1] : undefined;
    const shares = Boolean(parent && view.parents.get(id)?.has(parent));
    return kind === "sibling" ? shares : !shares;
  }));

// Paging the alternatives moves through them and never moves the path.
const pageOne = plainOf(await drive([TAB, "]"]));
const pageTwo = plainOf(await drive([TAB, "]", RIGHT]));
check("the right arrow pages the alternatives", pageOne !== pageTwo);
check("paging leaves the path where it was", breadcrumb(pageOne) === breadcrumb(pageTwo));
check("paging back returns", plainOf(await drive([TAB, "]", RIGHT, LEFT])) === pageOne);
check(
  "the counts either side add up to the other nodes at that level",
  (() => {
    const behind = Number((plainOf(pageTwo).match(/(\d+) ←/) ?? [])[1] ?? -1);
    const ahead = Number((plainOf(pageTwo).match(/→ (\d+)/) ?? [])[1] ?? -1);
    return behind >= 0 && ahead >= 0 && behind + ahead + 1 === kinded.aside.length;
  })(),
);

// Committing an alternative re-paths onto it, which is the point of the pane.
const committedHere = plainOf(await drive([TAB, "]", RIGHT, ENTER]));
check("enter re-paths onto the chosen alternative", breadcrumb(committedHere) !== breadcrumb(pageOne));

// The counts either side are the pagination: how many lie each way.
check(
  "the alternatives column counts what lies each way",
  /\d+ ←/.test(plainOf(alt)) && /→ \d+/.test(plainOf(alt)),
);
check("it draws one alternative in full", plainOf(alt).includes("┏"));
check("it names the alternative's level too", /┏━+ [A-Z]+ /.test(plainOf(alt)));
// Paging is a navigation, so it obeys the same invariant as everything else.
const altRest = await drive([TAB, "]"]);
const altMoved = await drive([TAB, "]", DOWN]);
const altBack = await drive([TAB, "]", DOWN, UP]);
check("paging the alternatives changes the card", plainOf(altMoved) !== plainOf(altRest));
check("paging back returns to the same card", plainOf(altBack) === plainOf(altRest));

// --- three concepts, three treatments ---------------------------------------
// The cursor is where you are, the anchor is what the view is built from, and
// the selection is what it covers. The anchor used to be invisible, so once the
// cursor walked off it nothing said what the paths were cycling around.
const runsOfHere = (frame: string) => runsOf(frame, GLYPH.here);
const runsOf = (frame: string, glyph: string) => {
  const marked = plainOf(frame)
    .split("\n")
    .map((line) => line.includes(glyph));
  return marked.filter((on, index) => on && !marked[index - 1]).length;
};

// --- picking nodes ----------------------------------------------------------
// The selection is gathered across views, so it must survive everything that
// changes what is on screen.
const pickOne = await stateAfter([SPACE], target, 0);
check("space picks the node under the cursor", plainOf(pickOne).includes("1 picked"));
check("the selection pane appears once something is picked", /PICKED/.test(plainOf(pickOne)));
check(
  "space again unpicks it",
  !plainOf(await stateAfter([SPACE, SPACE], target, 0)).includes("picked"),
);
check(
  "picking two keeps both",
  plainOf(await stateAfter([SPACE, DOWN, SPACE], target, 0)).includes("2 picked"),
);
check(
  "the selection survives switching view",
  plainOf(await stateAfter([SPACE, TAB, TAB], target, 0)).includes("1 picked"),
);
check(
  "the selection survives cycling paths",
  plainOf(await stateAfter([TAB, SPACE, RIGHT], target, 0)).includes("1 picked"),
);
check(
  "the selection survives re-anchoring",
  plainOf(await stateAfter([SPACE, DOWN, ENTER], target, 0)).includes("1 picked"),
);
// The pane only exists once there is something in it, so the brackets only
// reach it then.
check(
  "the brackets reach the selection pane",
  /PICKED/.test(plainOf(await stateAfter([SPACE, "]"], target, 0))),
);

// --- a pick is visible where you made it ------------------------------------
// Picking a node changed nothing on screen except a strip at the bottom, so in
// every view the node you had just picked looked exactly like one you had not.
// It gets its own reserved column, because being picked is independent of the
// cursor and of the anchor and can be true at the same time as either.
{
  const unpicked = plainOf(await stateAfter([], target, 0));
  check("nothing is marked before anything is picked", !unpicked.includes(GLYPH.picked));
  for (const [name, presses] of [
    ["level", [SPACE]],
    ["path", [TAB, SPACE]],
    ["down", [TAB, TAB, SPACE]],
    ["up", [TAB, TAB, TAB, SPACE]],
    ["hourglass", [TAB, TAB, TAB, TAB, SPACE]],
  ] as const) {
    const frame = plainOf(await stateAfter([...presses], target, 0));
    check(`${name} view marks a picked node`, frame.includes(GLYPH.picked));
  }
  // The mark is its own column, so it survives the cursor being elsewhere.
  // Pick a step, then move the cursor to its neighbour rather than away from it:
  // a window that scrolls the picked card off screen is a different question,
  // and would make this pass or fail for the wrong reason.
  const moved = plainOf(await stateAfter([TAB, UP, SPACE, DOWN], target, 0));
  check("the mark stays when the cursor moves off the picked node", moved.includes(GLYPH.picked));
  check("...and the cursor is still drawn too", moved.includes(GLYPH.here));
}

// --- the key is read as it was meant ----------------------------------------
// A dotenv value keeps its quotes through `$(sed …)`, and those quotes went out
// in the header and came back a 401 — so the editor announced a refused key
// while holding a perfectly good one.
{
  const before = process.env.ANTHROPIC_API_KEY;
  for (const [label, raw, want] of [
    ["a plain key is untouched", "sk-ant-abc", "sk-ant-abc"],
    ["double quotes come off", '"sk-ant-abc"', "sk-ant-abc"],
    ["single quotes come off", "'sk-ant-abc'", "sk-ant-abc"],
    ["padding comes off", "  sk-ant-abc  ", "sk-ant-abc"],
    ["quotes and padding together", '  "sk-ant-abc"  ', "sk-ant-abc"],
  ] as const) {
    process.env.ANTHROPIC_API_KEY = raw;
    check(label, apiKey() === want);
  }
  process.env.ANTHROPIC_API_KEY = "";
  check("an empty key is no key", apiKey() === undefined && !apiAvailable());
  process.env.ANTHROPIC_API_KEY = '""';
  check("a key that is only quotes is no key", apiKey() === undefined);
  if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = before;
}

// --- the review pane speaks only in claims ----------------------------------
// The pane used to diff identifiers: `− context.a-report-longer-than-…` is a
// pointer drawn as if it were content, and for a regoverned claim there is no
// textual difference to show at all. Every operation is now identified by the
// sentence it acts on.
{
  const restatable = [...view.byId.values()].find((n) => n.level === "product")!;
  const contextual = [...view.byId.values()].find(
    (n) => n.level === "context" && n.constrainedBy.some((p) => p.endsWith(".*")),
  )!;
  const target2 = [...view.byId.values()].find((n) => n.level === "context" && n.id !== contextual.id)!;
  const every: Change[] = [
    { kind: "restated", id: restatable.id, statement: "The system does something else." },
    { kind: "regoverned", id: contextual.id, constrainedBy: [target2.id] },
    { kind: "added", level: "product", statement: "The system names a new thing.", constrainedBy: [restatable.id] },
    { kind: "withdrawn", id: restatable.id },
  ];
  const ids = [...view.byId.keys()];
  for (const change of every) {
    const { kind, about, sides } = sidesOf(view, change);
    const words = [about ?? "", ...sides.map((s) => s.text)].join(" ");
    check(`${change.kind} names no node by id`, !ids.some((id) => words.includes(id)));
    check(`${change.kind} says something`, sides.length > 0 && sides.every((s) => s.text.length > 0));
    check(`${change.kind} keeps the graph's own word for it`, kind.startsWith(change.kind === "added" ? "added" : change.kind));
  }
  // An audience set is the one parent with no statement of its own.
  const wildcard = sidesOf(view, {
    kind: "regoverned",
    id: contextual.id,
    constrainedBy: [target2.id],
  });
  check(
    "an audience set is said as what it selects, not as its id",
    wildcard.sides.some((s) => s.text.startsWith("every ")) &&
      !wildcard.sides.some((s) => s.text.includes(".*")),
  );
  // A restatement needs no identifier: the − line IS the claim as it stands.
  const restated = sidesOf(view, every[0]!);
  check("a restatement shows the claim as it stands today", restated.sides[0]!.text === restatable.statement);
  check("...and what it would become", restated.sides[1]!.text === "The system does something else.");
  check("an addition has no losing side", sidesOf(view, every[2]!).sides.every((s) => s.mark === "becomes"));
  check("a withdrawal has no winning side", sidesOf(view, every[3]!).sides.every((s) => s.mark === "was"));
}

// --- the keys are written down once, per screen ------------------------------
// The hint line was typed by hand beside the code that handles the keys, and it
// had already drifted: it never mentioned `s`, so the only way to find
// suggestions was to be told. Both the line and the guide now read one table,
// and the table is keyed by screen — because "what can I do from here" is the
// question a reader actually has.
{
  const onGraphState = { mode: "browsing", reviewing: false, view: "level", paths: 1, pane: "graph" };
  const onGraph = screenFor(onGraphState);
  check("browsing lands on the graph screen", onGraph.id === "graph");
  check("a ready suggestion is its own screen", screenFor({ ...onGraphState, mode: "suggestions", reviewing: true }).id === "suggestion");
  check("...and one still arriving is another", screenFor({ ...onGraphState, mode: "suggestions" }).id === "waiting");
  check("typing is its own screen", screenFor({ ...onGraphState, mode: "talking", reviewing: true }).id === "typing");
  check("the menu is its own screen", screenFor({ ...onGraphState, mode: "menu" }).id === "menu");
  check("a proposal is its own screen", screenFor({ ...onGraphState, mode: "acting" }).id === "acting");
  check(
    "every state lands somewhere",
    ["browsing", "menu", "acting", "suggestions", "talking", "writing"].every((mode) =>
      Boolean(screenFor({ ...onGraphState, mode })),
    ),
  );

  for (const screen of SCREENS) {
    check(`${screen.id} offers at least one key`, screen.keys(onGraphState).length > 0);
    // A screen with no way out is a trap.
    check(
      `${screen.id} says how to leave`,
      screen.keys(onGraphState).some((key) => /esc|quit/.test(`${key.press} ${key.does}`)),
    );
    const pressed = screen.keys(onGraphState).map((key) => key.press);
    check(
      `${screen.id} says each key once`,
      new Set(pressed).size === pressed.length,
    );
    /**
     * No word names both a group and a thing inside it.
     *
     * `ask` was a group holding the keys that spend a model call, and also the
     * name of a mode two of those keys toggle — one word for two things in the
     * one list a reader reaches for when they are already lost. That is the
     * fault this product exists to catch, so the guide is held to it.
     */
    const groupWords = new Set(groupedKeys(screen, onGraphState).flatMap(({ group }) => group.split(/\s+/)));
    const clash = screen.keys(onGraphState).filter((key) =>
      key.does.split(/\s+/).some((word) => groupWords.has(word)),
    );
    check(
      `${screen.id}: no word names both a group and a key (${clash.map((k) => k.does).join("; ") || "none"})`,
      clash.length === 0,
    );
  }

  // Two keys mean different things on different screens. That is the reason the
  // table is keyed by screen at all: one row per key could only have described
  // one of them.
  const saysOn = (id: string, press: string) =>
    SCREENS.find((screen) => screen.id === id)!.keys(onGraphState).find((key) => key.press === press)?.does;
  check("a opens the actions menu on the graph", saysOn("graph", "a") === "actions");
  check("...and applies a proposal when reviewing one", saysOn("acting", "a") === "apply it");
  check("the arrows walk nodes on the graph", saysOn("graph", "↑ ↓") === "node");
  check("...and page suggestions at a suggestion", saysOn("suggestion", "↑ ↓") === "suggestion");
  // Mid-sentence `?` is a character, so the guide must not claim otherwise.
  check(
    "the guide key is absent while typing",
    !SCREENS.find((screen) => screen.id === "typing")!.keys(onGraphState).some((key) => key.press === "?"),
  );
  check(
    "...and present everywhere else",
    SCREENS.filter((screen) => screen.id !== "typing").every((screen) =>
      screen.keys(onGraphState).some((key) => key.press === "?"),
    ),
  );

  /**
   * The arrows are only offered where they move something.
   *
   * The level view was advertising `← → path` and there is no second path to
   * cycle there — the key did nothing, which is worse than not naming it, since
   * a reader presses it and concludes the editor is broken.
   */
  const pressesOn = (state: typeof onGraphState) =>
    screenFor(state).keys(state).map((key) => `${key.press} ${key.does}`);
  check("one path means the arrows are not offered", !pressesOn(onGraphState).includes("← → path"));
  check(
    "more than one path means they are",
    pressesOn({ ...onGraphState, view: "path", paths: 3 }).includes("← → path"),
  );
  // The same keys walk different things depending on which pane holds them.
  check("the arrows walk nodes in the graph pane", pressesOn(onGraphState).includes("↑ ↓ node"));
  check(
    "...picked nodes in the selection pane",
    pressesOn({ ...onGraphState, pane: "selection" }).includes("↑ ↓ picked node"),
  );
  check(
    "...and space unpicks there rather than picking",
    pressesOn({ ...onGraphState, pane: "selection" }).includes("␣ unpick"),
  );
  check(
    "the alternatives pane is its own screen",
    screenFor({ ...onGraphState, pane: "alternatives" }).id === "alternatives",
  );
  check(
    "...where the arrows page alternatives both ways",
    pressesOn({ ...onGraphState, pane: "alternatives" }).includes("← → alternative"),
  );
  // Each view is named, so a short list cannot be mistaken for a broken one.
  for (const view of ["level", "path", "down", "up", "hourglass"]) {
    check(
      `the guide names the ${view} view`,
      screenFor({ ...onGraphState, view }).title({ ...onGraphState, view }) === `the ${view} view`,
    );
  }

  const brief = briefKeys(onGraph, onGraphState);
  check("the hint line names suggestions", brief.includes("s suggest"));
  check("the hint line names the guide", brief.includes("? "));
  // The line shares one row with every other key, and going one character over
  // truncated the last entry — a key lost to an ellipsis reads as a key that
  // does not exist.
  check(`the hint line fits a narrow window (${brief.length + 3} of 120)`, brief.length + 3 <= 120);
  check(
    "a screen's hint line only names that screen's keys",
    !briefKeys(SCREENS.find((s) => s.id === "suggestion")!, onGraphState).includes("pick"),
  );
  check("the guide measures itself", keyRows(onGraph, onGraphState) > onGraph.keys(onGraphState).length);

  // Closed is a line, never nothing: a key nobody mentions is a key nobody
  // presses, and the column used to end after the references with no sign that
  // `?` meant anything at all.
  const closed = plainOf(await stateAfter([], target, 0));
  check("closed, the guide is one line rather than nothing", /\?\s+keyboard shortcuts/.test(closed));
  check("...and the full guide is not drawn", !/KEYS/.test(closed));
  check("...which sits under the references", closed.indexOf("REFERENCES") < closed.indexOf("keyboard shortcuts"));
  const opened = plainOf(await stateAfter(["?"], target, 0));
  check("? shows the guide", /KEYS/.test(opened));
  check("...naming the screen it is for", opened.includes("the level view"));
  check("...under the references", opened.indexOf("REFERENCES") < opened.indexOf("KEYS"));
  const missing = onGraph.keys(onGraphState).filter((key) => !opened.includes(key.press)).map((key) => key.press);
  check(`the open guide lists every key on this screen (${missing.join(", ") || "all present"})`, missing.length === 0);
  // And nothing from anywhere else: that is the whole point of keying by screen.
  check("...and nothing from another screen", !opened.includes("swap ask and amend"));
  const roomy = plainOf(await stateAfter(["?"], target, 0, 60));
  check(
    "...with its group headings when the window is tall enough",
    groupedKeys(onGraph, onGraphState).every(({ group }) => roomy.includes(group)),
  );
  check("the open guide says how to close it", /\? to close/.test(opened));
  const reclosed = plainOf(await stateAfter(["?", "?"], target, 0));
  check("? again closes it", !/KEYS/.test(reclosed));
  check("...back to the one line", /\?\s+keyboard shortcuts/.test(reclosed));
}

// --- typing does not close the thing you are typing into ---------------------
// Pressing `/` moves the mode from `suggestions` to `talking`, and the pane was
// mounted on a check for `suggestions` alone — so opening the input unmounted
// the pane the input lived in. The guide went on naming the screen over an
// empty column, which is what gave it away.
{
  const two: Suggestion[] = [
    { title: "a", summary: "s", changes: [{ kind: "withdrawn", id: picked[0]! }] },
    { title: "b", summary: "s", changes: [{ kind: "withdrawn", id: picked[1]! }] },
  ];
  check("a ready suggestion is under review", underReview("suggestions", two, 0)?.title === "a");
  check("...and stays under review while you type at it", underReview("talking", two, 0)?.title === "a");
  check("...the same one, not the next", underReview("talking", two, 1)?.title === "b");
  check("browsing reviews nothing", underReview("browsing", two, 0) === undefined);
  check("neither does writing to disk", underReview("writing", two, 0) === undefined);
  check("nothing to review means nothing under review", underReview("suggestions", [], 0) === undefined);
  check("...even while typing", underReview("talking", [], 0) === undefined);
  // The screen and the pane have to agree: a guide that names a screen the pane
  // is not drawing is exactly the state this bug produced.
  check(
    "the typing screen and the pane agree that something is under review",
    screenFor({ mode: "talking", reviewing: Boolean(underReview("talking", two, 0)), view: "level", paths: 1, pane: "graph" }).id === "typing" &&
      underReview("talking", two, 0) !== undefined,
  );
}

// --- talking back to a suggestion -------------------------------------------
// Two modes on one input: asking elaborates and changes nothing, amending
// replaces the proposal. Both are prompts about what is ON SCREEN, so neither
// may name a node by id — the reviewer is looking at sentences.
{
  const sample: Suggestion = {
    title: "Merge the two report claims",
    summary: "Both promise something about when a report is skipped.",
    changes: [
      { kind: "restated", id: picked[0]!, statement: "The system says one thing." },
      { kind: "withdrawn", id: picked[1]! },
    ],
  };
  const ids = [...view.byId.keys()];

  const question = promptForAsk(view, sample, 'what do you mean by "skipped"?');
  check("the question prompt carries the proposal as sentences", question.includes(sample.title));
  check("...including the claim as it stands today", question.includes(view.byId.get(picked[0]!)!.statement));
  check("...and the reader's question", question.includes('what do you mean by "skipped"?'));
  check("...naming no node by id", !ids.some((id) => question.includes(id)));
  check("...and forbidding the model from writing one", /Never write a node id/.test(question));

  const amend = promptForAmend(view, picked, sample, "keep the merge but do not withdraw anything");
  check("the amend prompt carries the instruction", amend.includes("do not withdraw anything"));
  check("...and the proposal being revised", amend.includes(sample.title));
  // A revision has to satisfy every rule the first proposal did, so it carries
  // the whole graph prompt rather than a summary of it.
  check("...and the shape rule", amend.includes("do not overlap"));
  check("...and the style rule", amend.includes("ASD-STE100"));

  check(
    "an answer is read out of the reply",
    parseAnswer(JSON.stringify({ answer: "  Because a skipped report is one nobody read.  " })) ===
      "Because a skipped report is one nobody read.",
  );
  for (const [label, reply] of [
    ["no JSON", "sorry, I cannot"],
    ["no answer field", JSON.stringify({ suggestions: [] })],
    ["an empty answer", JSON.stringify({ answer: "   " })],
  ] as const) {
    check(`a reply with ${label} is refused so it is asked again`, (() => {
      try {
        parseAnswer(reply);
        return false;
      } catch {
        return true;
      }
    })());
  }

  // What an amendment moved is worked out here, not asked for.
  const kept = sample.changes[0]!;
  const revised: Suggestion = {
    title: "Merge them",
    summary: "s",
    changes: [kept, { kind: "added", level: "product", statement: "A new claim.", constrainedBy: [picked[0]!] }],
  };
  check("a change carried over is recognised as the same", sameChange(kept, revised.changes[0]!));
  check("a change the amendment introduced is not", !sameChange(kept, revised.changes[1]!));
  check(
    "a restatement to different words is a different change",
    !sameChange(kept, { kind: "restated", id: picked[0]!, statement: "Something else." }),
  );
  // An instruction a proposal already meets is answered, not retried: the model
  // rightly sends the same changeset back, `usable` rightly reads every one of
  // those as changing nothing, and asking twice more cannot improve on it.
  check("a revision that moved nothing is recognised", !moved(sample, { ...sample }));
  check("a revision that added a change moved", moved(sample, revised));
  check(
    "a revision that dropped a change also moved",
    moved(revised, { ...revised, changes: [revised.changes[0]!] }),
  );
  check(
    "the order of parents does not make a regoverning different",
    sameChange(
      { kind: "regoverned", id: picked[0]!, constrainedBy: ["a", "b"] },
      { kind: "regoverned", id: picked[0]!, constrainedBy: ["b", "a"] },
    ),
  );
}

// --- typing at a suggestion -------------------------------------------------
// While the reader is mid-sentence every key is a character. This suite runs
// with prefetch off, so `s` reaches "asking…" and no further — enough to prove
// the input is unreachable before there is anything to talk about, which is the
// state the key guard has to get right.
{
  const asking = plainOf(await stateAfter([SPACE, DOWN, SPACE, "s"], target, 0));
  check("a suggestion that has not arrived offers nothing to talk to", !/ask ›|amend ›/.test(asking));
}

// The pane itself, drawn against synthetic proposals: the suite cannot reach a
// real suggestion without a model call, and everything worth checking here is
// what the pane does with one once it has it.
{
  const drawPane = async (props: Partial<Parameters<typeof ReviewPane>[0]> & { suggestion: Suggestion }) => {
    const seen: string[] = [];
    const out = new Writable({
      write(chunk, _e, cb) {
        seen.push(String(chunk));
        cb();
      },
    });
    Object.assign(out, { columns: 120, rows: 40, isTTY: true });
    const instance = render(
      <ReviewPane view={view} at={0} total={3} width={118} cap={18} {...props} />,
      { stdout: out as never, patchConsole: false },
    );
    await settle();
    instance.unmount();
    return plainOf(seen.join(""));
  };

  const base: Suggestion = {
    title: "Merge the two report claims",
    summary: "Both promise something about when a report is skipped.",
    changes: [{ kind: "restated", id: picked[0]!, statement: "The system says one thing." }],
  };

  const plainPane = await drawPane({ suggestion: base });
  check("the pane shows the summary when nothing has been asked", plainPane.includes("Both promise something"));
  check("...and offers the input", /\/ ask or amend/.test(plainPane));

  const typing = await drawPane({ suggestion: base, talking: { kind: "ask", text: "what is a report" } });
  check("typing shows which mode the next key is in", /ask ›/.test(typing));
  check("...echoes what has been typed", typing.includes("what is a report"));
  check("...and names the other mode on tab", /tab amend/.test(typing));
  const amending = await drawPane({ suggestion: base, talking: { kind: "amend", text: "keep the merge" } });
  check("the other mode says so too", /amend ›/.test(amending) && /tab ask/.test(amending));

  const answeredPane = await drawPane({
    suggestion: base,
    answered: { question: "what is a report?", answer: "A report is what a check prints." },
  });
  check("an answer echoes the question", answeredPane.includes("what is a report?"));
  check("...and shows the answer", answeredPane.includes("A report is what a check prints."));
  // The answer stands where the summary was: you asked because the summary did
  // not settle it, so the answer is the thing to read.
  check("...in place of the summary", !answeredPane.includes("Both promise something"));
  check("...while the title still says which proposal it is about", answeredPane.includes("Merge the two report claims"));

  const revised: Suggestion = {
    ...base,
    changes: [
      base.changes[0]!,
      { kind: "added", level: "product", statement: "A brand new claim.", constrainedBy: [picked[0]!] },
    ],
  };
  const amended = await drawPane({ suggestion: revised, amendedFrom: base });
  check("an amendment marks what it introduced", amended.includes("amended"));
  check(
    "...and marks it only there",
    (amended.match(/amended/g) ?? []).length === 1,
  );
  const shrunk = await drawPane({ suggestion: base, amendedFrom: revised });
  check("...and counts what it dropped", /1 dropped/.test(shrunk));
  check("an unamended pane counts nothing", !/dropped/.test(plainPane));

  const busy = await drawPane({ suggestion: base, waiting: true });
  check("a sent message says it is waiting", /asking…/.test(busy));
}

// --- s always answers -------------------------------------------------------
// The key used to be ignored unless a reply had already arrived, so it was dead
// in exactly the cases a reader would first try it: browsing with prefetch off,
// or before picking a second node. This whole suite runs with prefetch off, so
// it is the dead case by construction.
check(
  "s with nothing picked says what to do instead of nothing",
  /pick two or more/i.test(plainOf(await stateAfter(["s"], target, 0))),
);
check(
  "s with one picked says the same",
  /pick two or more/i.test(plainOf(await stateAfter([SPACE, "s"], target, 0))),
);
check(
  "s with two picked asks, even though nothing prefetched",
  /asking/i.test(plainOf(await stateAfter([SPACE, DOWN, SPACE, "s"], target, 0))),
);

// --- the picked set is drawn as whatever shape the graph says it has ---------
// A list said only that you had picked three things. These four cases are what
// the graph can say about a set instead, ordered by how much they claim.
{
  const levelOf = (id: string) => view.byId.get(id)!.level;
  const someLevel = [...view.byId.values()].filter((n) => n.level === "product").slice(0, 3).map((n) => n.id);
  check("a same-level pick is called out as one level", groupOf(view, someLevel).kind === "level");
  check(
    "...and names which level",
    (groupOf(view, someLevel) as { level: string }).level === "product",
  );

  const line = pathsTo(view, deep)[0]!;
  const ends = [line[0]!, line.at(-1)!];
  const onePath = groupOf(view, ends);
  check("two ends of one line are called a line of descent", onePath.kind === "path");
  check(
    "the line it draws includes the steps nobody picked",
    onePath.kind === "path" && onePath.ids.length > ends.length && ends.every((id) => onePath.ids.includes(id)),
  );

  const parent = [...view.byId.values()].find((n) => (view.children.get(n.id)?.size ?? 0) >= 2)!;
  const kids = [...(view.children.get(parent.id) ?? [])].slice(0, 2);
  const sibs = groupOf(view, kids);
  check("two children of one claim are called siblings", sibs.kind === "siblings");
  check("...and it names the claim that constrains them", sibs.kind === "siblings" && sibs.parent === parent.id);

  const far = [
    [...view.byId.values()].find((n) => n.level === "context")!.id,
    [...view.byId.values()].find((n) => n.level === "mechanism")!.id,
  ];
  const scattered = groupOf(view, far);
  check(
    "a set the graph does not relate is called unrelated",
    scattered.kind === "scattered" || scattered.kind === "path",
  );

  // The budget and the drawing must agree, or the frame runs off the bottom.
  for (const g of [groupOf(view, someLevel), onePath, sibs, scattered]) {
    check(`${g.kind} reserves at least a heading and its rows`, selectionRows(g, 5) >= 1 + Math.min(g.ids.length, 5));
  }
  check("a level box costs its two edges", selectionRows(groupOf(view, someLevel), 5) === 1 + 2 + 3);
  check("siblings cost a row for the parent", selectionRows(sibs, 5) === 1 + 1 + kids.length);
}

// --- swapping paths keeps the cursor on the path ----------------------------
// The cursor used to stay on the node the swap replaced, which is on no card in
// the new path — so after a press nothing on screen was marked at all.
const beforeSwap = await stateAfter([UP], target, 1, 48);
const afterSwap = await stateAfter([UP, RIGHT], target, 1, 48);
check("before the swap the cursor is marked", runsOfHere(beforeSwap) === 1);
check("after the swap the cursor is still marked", runsOfHere(afterSwap) === 1);
check("the swap actually changed the path", breadcrumb(beforeSwap) !== breadcrumb(afterSwap));
check(
  "swapping and swapping back returns exactly",
  (await stateAfter([UP, RIGHT, LEFT], target, 1, 48)) === beforeSwap,
);

const atAnchor = await stateAfter([], target, 1);
check("with the cursor on the anchor, only the cursor is marked", runsOf(atAnchor, GLYPH.anchor) === 0);
check("...and the heading does not bother naming it", !plainOf(atAnchor).includes("anchored at"));

// Up rather than down: the cursor starts on the last step, so up keeps both it
// and the anchor inside the window. Down scrolls the anchor off — which is the
// case the heading note exists for, and is asserted separately below.
const movedOff = await stateAfter([UP], target, 1, 48);
check("moving the cursor off the anchor marks the anchor", runsOf(movedOff, GLYPH.anchor) === 1);
check("the cursor is still marked, exactly once", runsOf(movedOff, GLYPH.here) === 1);
check("the heading names the anchor once the two differ", plainOf(movedOff).includes("anchored at"));
check(
  "the two marks are on different cards",
  (() => {
    const lines = plainOf(movedOff).split("\n");
    const anchorAt = lines.findIndex((line) => line.includes(GLYPH.anchor));
    const cursorAt = lines.findIndex((line) => line.includes(GLYPH.here));
    return anchorAt >= 0 && cursorAt >= 0 && anchorAt !== cursorAt;
  })(),
);

// Anchoring where the cursor is collapses the two back into one.
check(
  "enter puts the anchor back under the cursor",
  runsOf(await stateAfter([UP, ENTER], target, 1, 48), GLYPH.anchor) === 0,
);

// When the anchor scrolls out of the window the mark goes with it, so the
// heading has to carry the fact on its own.
const anchorOffscreen = await stateAfter([DOWN], target, 1);
check("the anchor can scroll off the window", runsOf(anchorOffscreen, GLYPH.anchor) === 0);
check(
  "...and the heading still says where the view is anchored",
  plainOf(anchorOffscreen).includes("anchored at"),
);

// --- a preview stays behind the path ----------------------------------------
// Readable if you look at it, never competing with the node it is a preview of.
const rawWide = await driveWide([TAB]);
const boldLegends = (rawWide.match(/\u001B\[1m\u001B\[38;2;\d+;\d+;\d+m[A-Z]+/g) ?? []).length;
const allLegends = (plainOf(rawWide).match(/[╭┏][─━][─━] [A-Z]+…? /g) ?? []).length;
check("some legends are bold — the path's own cards", boldLegends > 0);
check(
  `the previews' legends are not (${boldLegends} bold of ${allLegends})`,
  boldLegends < allLegends,
);

check("a opened the action menu", afterMenu.includes("reword") && afterMenu.includes("critique"));
check("the menu names the selection shape and its alternatives", afterMenu.includes("path selected ·"));
check("the menu offers percolate on a path", afterMenu.includes("percolate"));

function hex(value: string): string {
  const n = Number.parseInt(value.slice(1), 16);
  return `${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
}

console.log(
  `nodes ${view.byId.size}   refs ${view.references.length}   terms ${view.terms.length}   ${view.status}`,
);
console.log(`actions: ${ACTIONS.map((a) => `${a.key}=${a.id}`).join("  ")}`);
console.log(`paths to ${target}: ${targetPaths.length}   tallest frame ${Math.max(...paints)}/34 rows\n`);
console.log(frame.slice(frame.lastIndexOf("[2J") + 1).split("\n").slice(-24).join("\n"));

if (failures.length) {
  console.error(`\nFAILED (${failures.length}):\n${failures.map((f) => `  - ${f}`).join("\n")}`);
  process.exit(1);
}
console.log(`\nall ${failures.length === 0 ? "checks" : ""} passed`);
process.exit(0);
