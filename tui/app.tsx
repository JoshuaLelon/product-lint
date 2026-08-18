/**
 * Walking skeleton of the graph editor.
 *
 * Three panes over one selection: the graph on the left, the vocabulary and the
 * references on the right, both filtered to whatever the graph pane has
 * selected. The selection is a PATH — a root-to-node chain through
 * `constrainedBy` — because a claim only means something relative to what
 * constrains it, and because the path is what the actions are typed on.
 *
 * Tab moves focus between the three panes; the focused one takes the arrow keys.
 * Left and right always cycle the paths of the node under the cursor, because
 * both side panes are derived from the path and changing it is what refills them.
 *
 * The interaction budget is the design constraint. Measured on this graph: a
 * frame costs 0.5ms, a re-read after an edit costs 8ms, and a model call costs
 * 13000ms. So the model never sits between a keypress and a repaint. It runs
 * ahead of the cursor instead, and a keypress only ever reads what has already
 * arrived.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
import {
  readGraph,
  pathsThrough,
  pathsTo,
  referencesFor,
  wordsFor,
  writeStatement,
  type GraphView,
} from "./graph.js";
import { apiNote, askFor } from "./claude.js";
import { apply as applyChanges, type Suggestion } from "./changes.js";
import { amendWith, askAbout, moved, suggestFor } from "./suggest.js";
import { actionByKey, actionsFor, shapeOf, type Action, type Proposal, type Selection } from "./actions.js";
import { GLYPH, LEVEL, SURFACE } from "./theme.js";
import { LayoutView, SelectionPanel } from "./layouts.js";
import { ReviewPane, reviewRows, underReview, type Answered } from "./review.js";
import { groupOf, selectionRows } from "./selection.js";
import { briefKeys, groupedKeys, keyRows, screenFor, type KeyState, type Screen } from "./keys.js";
import { VIEWS, type ViewId } from "./views.js";
import type { KnowledgeLevel, ResolvedConfig, SourceCanonicalNode } from "../src/types.js";

/** Levels arrive as plain strings from the row list; the ramp is keyed by level. */
const levelColor = (level: string): string | undefined => LEVEL[level as KnowledgeLevel];

/** How long the cursor must rest before we spend a model call on where it landed. */
const SETTLE_MS = 350;

/** Held arrow keys must not open a process per row. */
const MAX_IN_FLIGHT = 2;

/**
 * `PL_TUI_PREFETCH=off` browses without spending a model call per node the
 * cursor rests on. The actions still work; they just wait rather than arriving warm.
 */
const PREFETCH = process.env.PL_TUI_PREFETCH !== "off";

/** Only the default action runs ahead of the cursor. The rest are asked for. */
const PREFETCHED = "reword";

/**
 * A long edit set is summarised rather than allowed to outgrow the window.
 *
 * The cap is also scaled down on a short terminal: three rows per edit will
 * overrun a twenty-row window long before it reaches six, and an overrunning
 * frame is exactly the ghosting the alternate screen was brought in to stop.
 */
/**
 * How many picked nodes the panel draws before it starts counting instead.
 *
 * The panel steals its rows from the graph above it, so this is what stops a
 * long pick from squeezing the view down to nothing.
 */
const SELECTION_CAP = 5;

/**
 * Rows the review pane may take.
 *
 * More than the browsing panel gets, because reading prose and checking wording
 * is the one moment the bottom of the screen is the thing you are looking at —
 * and it is still a cap, so a suggestion with six changes cannot squeeze the
 * graph away.
 */
const REVIEW_CAP = 12;

const MAX_EDITS_SHOWN = 6;
function editsToShow(rows: number): number {
  return Math.max(1, Math.min(MAX_EDITS_SHOWN, Math.floor((rows - 14) / 3)));
}

type Focus = "graph" | "alternatives" | "selection" | "vocabulary" | "references";
/**
 * Panes are per-view: alternatives only exist where a view offers any, and the
 * selection only becomes a place to go once the reader has picked something.
 */
const panesFor = (hasAside: boolean, hasSelection: boolean): Focus[] => [
  "graph",
  ...(hasAside ? (["alternatives"] as const) : []),
  ...(hasSelection ? (["selection"] as const) : []),
  "vocabulary",
  "references",
];

/**
 * Focus is a node id, not a row index.
 *
 * Every view answers "for the node I am on, show me ___", so switching view has
 * to keep the node and change the lens. An index would mean something different
 * in each view's ordering and would land you somewhere arbitrary on every
 * switch, which is the one thing a view switcher must not do.
 */
const FIRST_VIEW: ViewId = "level";

type Entry =
  | { status: "loading" }
  | { status: "ready"; proposal: Proposal }
  | { status: "failed"; message: string };

type Suggested =
  | { status: "loading" }
  | { status: "ready"; suggestions: Suggestion[] }
  | { status: "failed"; message: string };

type Mode =
  | { name: "browsing" }
  | { name: "suggestions" }
  | { name: "menu" }
  | { name: "acting"; action: Action }
  /**
   * The reader is typing at a suggestion.
   *
   * Not `writing` — that one means the editor is writing to disk and is
   * deliberately deaf to the keyboard, which is the opposite situation.
   */
  | { name: "talking"; kind: "ask" | "amend"; text: string }
  | { name: "writing" };

/**
 * Keyed by statement as well as id, so accepting a rewording invalidates the
 * suggestions that were made about the wording it replaced — and by action, so
 * a critique is never answered with a reword.
 */
export function cacheKey(action: string, node: SourceCanonicalNode, path: string[]): string {
  return `${action} ${path.join(">")} ${node.statement}`;
}

/**
 * Focus rides the emphasis channel, never the hue channel. The focused pane is
 * bold and undimmed with a heavy rail; the others go dim. Colouring it amber
 * would make one hue mean both "you selected this path" and "this pane takes the
 * arrow keys", which vary independently and would collide constantly.
 */
/**
 * Three graph states, three treatments.
 *
 * Complete is settled. Invalid or stale is a problem. Merely owed is neither —
 * it gets no hue, because the graph's own claim is that an incomplete graph does
 * not block work, and the CLI gives it its own exit code. Painting an owed node
 * red would overstate it and cheapen the colour that means contradiction.
 */
export function statusColor(state: { complete: boolean; blocked: boolean }): string | undefined {
  if (state.complete) return SURFACE["status.complete"];
  if (state.blocked) return SURFACE["status.blocked"];
  return undefined;
}

/**
 * The keyboard guide, under the references.
 *
 * Not a pane you can focus: it is a thing you read and then dismiss, and adding
 * it to the `[ ]` cycle would put a stop on the way round that never has
 * anything to select. Every row comes from the one table, so it cannot describe
 * a key the editor no longer has.
 *
 * A key that would do nothing in the mode you are in is drawn dim rather than
 * hidden — where it lives is worth learning even when it is not available, and
 * a list that reshuffles as you move is a list you cannot build a habit on.
 */
function Keys({
  screen,
  state,
  width,
  compact,
}: { screen: Screen; state: KeyState; width: number; compact: boolean }) {
  return (
    <Box flexDirection="column">
      {/* The screen is named, because the list is now only that screen's keys
          and a reader who cannot see which screen they are on cannot tell a
          short list from a broken one. */}
      <Text wrap="truncate">
        <Text dimColor bold>{`${GLYPH.railOff} KEYS`}</Text>
        <Text dimColor>{`  ${screen.title(state)}`}</Text>
        <Text dimColor>{"   ? to close"}</Text>
      </Text>
      {groupedKeys(screen, state).map(({ group, keys }) => (
        <Box key={group} flexDirection="column">
          {!compact && <Text dimColor>{`  ${group}`}</Text>}
          {keys.map((key) => (
            <Text key={`${group}-${key.press}`} wrap="truncate">
              <Text bold>{`   ${key.press.padEnd(6)}`}</Text>
              <Text>{key.does.slice(0, Math.max(4, width - 10))}</Text>
            </Text>
          ))}
        </Box>
      ))}
    </Box>
  );
}

function Title({ text, focused }: { text: string; focused: boolean }) {
  return (
    <Text dimColor={!focused} bold={focused}>
      {`${focused ? GLYPH.railOn : GLYPH.railOff} ${text.toUpperCase()}`}
    </Text>
  );
}

/**
 * One side-pane entry.
 *
 * Two shapes, because a pane holds two kinds of thing and they must not read
 * alike. A `definition` is authored content — prose, at full weight, indented
 * under the word it belongs to. A `detail` is the tool talking ABOUT the
 * content, so it is a compact dim column on the same line as its head. Rendering
 * both as dim prose is what made a term's definition indistinguishable from a
 * warning about a word nobody has defined.
 */
interface Item {
  key: string;
  head: string;
  headColor?: string;
  headDim?: boolean;
  definition?: string;
  detail?: string;
}

/** A labelled run of entries, so findings sit under a heading that names them. */
interface Group {
  key: string;
  label?: string;
  items: Item[];
}

/**
 * Wrap to fixed lines, each already indented.
 *
 * Done here rather than left to Ink because a terminal has no hanging indent:
 * let it wrap and the second line of a definition starts hard against the pane
 * edge, under the heading rather than beside it, and the eye stops reading it as
 * one entry. Wrapping by hand also makes the height exact, so the pane budget
 * below is arithmetic instead of an estimate.
 */
function wrapText(text: string, width: number, indent: string): string[] {
  const room = Math.max(8, width - indent.length);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > room) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.map((each) => indent + each);
}

/**
 * As many whole entries as the budget holds, from `offset`.
 *
 * Whole entries rather than lines: half a definition is worse than no
 * definition, because the reader cannot tell that the rest exists.
 */
function bodyLines(item: Item, width: number): string[] {
  return item.definition ? wrapText(item.definition, width, "     ") : [];
}

function costOf(item: Item, width: number): number {
  return 1 + bodyLines(item, width).length;
}

/**
 * Every row a group would take if nothing rationed it.
 *
 * A labelled group after the first also gets a blank row above it. Prose and a
 * table butted together read as one run; a single empty line is what separates
 * "here is what this word means" from "here are words nothing defines".
 */
function groupHeight(group: Group, width: number, first: boolean): number {
  return (
    (group.label ? 1 : 0) +
    (group.label && !first ? 1 : 0) +
    group.items.reduce((rows, item) => rows + costOf(item, width), 0)
  );
}

function naturalHeight(groups: Group[], width: number): number {
  return groups.reduce((total, group, index) => total + groupHeight(group, width, index === 0), 0);
}

/**
 * Emit rows against a hard budget.
 *
 * Row by row rather than entry by entry, so a definition longer than the whole
 * pane clips instead of pushing the frame past the window. The "N more" notice
 * comes out of the budget too — two panes each overrunning by one line is enough
 * to strand a frame's top off the screen.
 */
function Entries({
  groups,
  width,
  budget,
  offset,
}: {
  groups: Group[];
  width: number;
  budget: number;
  offset: number;
}) {
  const flat = groups.flatMap((group, groupIndex) =>
    group.items.map((item, index) => ({
      item,
      label: index === 0 ? group.label : undefined,
      spaced: index === 0 && Boolean(group.label) && groupIndex > 0,
    })),
  );
  const visible = flat.slice(offset);
  const rows: ReactNode[] = [];
  let remaining = budget;
  let shown = 0;

  for (const { item, label, spaced } of visible) {
    const cost = costOf(item, width) + (label ? 1 : 0) + (spaced ? 1 : 0);
    // Leave a row for the notice once anything is going to be left out.
    if (shown > 0 && remaining - cost < (visible.length - shown > 1 ? 1 : 0)) break;
    if (remaining <= 0) break;

    if (spaced) {
      rows.push(<Text key={`gap:${item.key}`}>{" "}</Text>);
      remaining -= 1;
    }
    if (label) {
      rows.push(
        <Text key={`label:${item.key}`} dimColor wrap="truncate">
          {`  ${label}`}
        </Text>,
      );
      remaining -= 1;
    }
    if (remaining <= 0) break;

    rows.push(
      <Text key={item.key} wrap="truncate">
        <Text color={item.headColor} dimColor={item.headDim} bold={!item.headDim}>
          {`  ${item.head}`}
        </Text>
        {item.detail && <Text dimColor>{`  ${item.detail}`}</Text>}
      </Text>,
    );
    remaining -= 1;
    shown += 1;

    for (const [index, line] of bodyLines(item, width).entries()) {
      if (remaining <= 0) break;
      rows.push(
        <Text key={`${item.key}:${index}`} wrap="truncate">
          {line}
        </Text>,
      );
      remaining -= 1;
    }
  }

  const hidden = visible.length - shown;
  return (
    <Box flexDirection="column">
      {rows}
      {hidden > 0 && <Text dimColor>{`  … ${hidden} more`}</Text>}
    </Box>
  );
}

export function App({
  config,
  initial,
  startAt,
}: {
  config: ResolvedConfig;
  initial: GraphView;
  /** Open with the cursor on this node id, so a deep node needs no scrolling. */
  startAt?: string;
}) {
  const { exit } = useApp();
  const size = useWindowSize(); // re-renders on resize, so the layout reflows
  const [view, setView] = useState(initial);
  // The anchor is what the view is drawn from; the cursor is where the reader
  // is. Keeping them apart is what makes the arrows reversible: down-then-up now
  // returns, because the order the cursor walks does not change under the press.
  const [anchorId, setAnchorId] = useState(() => {
    // A partial id is enough: typing the whole slug to reach a node defeats the
    // point of being able to jump to one.
    const ids = initial.rows.filter((r) => r.kind === "node").map((r) => r.node!.id);
    return (startAt && ids.find((id) => id.includes(startAt))) ?? ids[0] ?? "";
  });
  const [cursorId, setCursorId] = useState(anchorId);
  const [viewId, setViewId] = useState<ViewId>(FIRST_VIEW);
  const [selection, setSelection] = useState(0);
  const [focus, setFocus] = useState<Focus>("graph");
  const [scroll, setScroll] = useState({ vocabulary: 0, references: 0 });
  const [asideIndex, setAsideIndex] = useState(0);
  /**
   * The selection: nodes the reader picked, in the order they picked them.
   *
   * Deliberately not derived from the view. The point is that it survives
   * switching view, cycling paths and moving the anchor, because the reader is
   * gathering nodes that no single view puts together.
   */
  const [selected, setSelected] = useState<string[]>([]);
  /**
   * Whether the guide is open. Closed is a line, never nothing.
   *
   * A feature reachable only by a key nobody mentions does not exist, and the
   * column used to end after the references with no sign that `?` meant
   * anything. Closed now leaves one row saying so, which is the whole of what a
   * reader needs to find the rest — and the same key puts it back.
   */
  const [showKeys, setShowKeys] = useState(false);
  /**
   * An answer, and the proposal an amendment revised.
   *
   * Both belong to the suggestion on screen and to no other, so both are dropped
   * the moment the reader moves off it — an answer left showing beside a
   * different proposal reads as an answer about that one.
   */
  const [answered, setAnswered] = useState<Answered | undefined>(undefined);
  const [amendedFrom, setAmendedFrom] = useState<Suggestion | undefined>(undefined);
  const [waiting, setWaiting] = useState(false);
  const [selectedAt, setSelectedAt] = useState(0);
  const [suggestionAt, setSuggestionAt] = useState(0);
  const [mode, setMode] = useState<Mode>({ name: "browsing" });

  // The proposal store lives in a ref so a background arrival repaints without
  // making the prefetch effect depend on its own output.
  const store = useRef(new Map<string, Entry>());
  const inFlight = useRef(0);
  // Keyed on the set itself, sorted, so removing a node and putting it back is a
  // cache hit rather than another call.
  const advice = useRef(new Map<string, Suggested>());
  const selectionKey = [...selected].sort().join(" ");
  const suggested = advice.current.get(selectionKey);
  const [, repaint] = useReducer((n: number) => n + 1, 0);

  const node = view.byId.get(cursorId);
  const lens = VIEWS.find((each) => each.id === viewId) ?? VIEWS[0];
  const rendering = useMemo(
    () => lens.build(view, anchorId, selection, cursorId),
    [lens, view, anchorId, selection, cursorId],
  );
  // Actions run on the node under the cursor, so they need a line that contains
  // it. The view's own path already does whenever the cursor sits on it.
  const selectedPath = useMemo(
    () => (rendering.path.includes(cursorId) ? rendering.path : (pathsThrough(view, cursorId)[0] ?? [cursorId])),
    [rendering, cursorId, view],
  );
  const onPath = useMemo(() => new Set(rendering.lit), [rendering]);

  const target: Selection | undefined = node ? { view, node, path: selectedPath } : undefined;
  // The side panes read the view's selection, whatever shape it took: a path in
  // path view, a cone in a tree view, a node and its neighbours in level view.
  const words = useMemo(() => wordsFor(view, rendering.lit), [view, rendering]);
  const references = useMemo(() => referencesFor(view, rendering.lit), [view, rendering]);

  const actingKey =
    mode.name === "acting" && target
      ? cacheKey(mode.action.id, target.node, target.path)
      : undefined;
  const acting = actingKey ? store.current.get(actingKey) : undefined;

  const run = useCallback(
    (action: Action, sel: Selection) => {
      const key = cacheKey(action.id, sel.node, sel.path);
      if (store.current.has(key)) return;
      inFlight.current += 1;
      store.current.set(key, { status: "loading" });
      repaint();
      askFor(action.prompt(sel), (raw) => action.parse(raw, sel))
        .then((proposal) => store.current.set(key, { status: "ready", proposal }))
        .catch((error) =>
          store.current.set(key, { status: "failed", message: String(error?.message ?? error) }),
        )
        .finally(() => {
          inFlight.current -= 1;
          repaint();
        });
    },
    [],
  );

  // Run the default action ahead of the cursor, so pressing for it on a node you
  // have been looking at is usually instant.
  useEffect(() => {
    if (!target || !PREFETCH) return;
    const action = actionByKey(target, "r");
    if (!action) return;
    if (store.current.has(cacheKey(action.id, target.node, target.path))) return;
    const timer = setTimeout(() => {
      if (inFlight.current >= MAX_IN_FLIGHT) return;
      run(action, target);
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [node, selectedPath.join(">"), run]);

  /**
   * Ask what to do with the set, whenever the set changes.
   *
   * Debounced like the reword prefetch: picking four nodes is four keystrokes,
   * and firing on each of them would spend four calls to answer a question the
   * reader had not finished asking.
   */
  /**
   * One way to ask, whether the cursor asked for you or you pressed the key.
   *
   * Kept as a function rather than living inside the effect so that `s` can
   * reach it: with prefetch off, the effect never runs, and a key that could
   * only read what the effect had already fetched had nothing to read.
   */
  const askForSuggestions = useCallback(() => {
    if (selected.length < 2) return;
    if (advice.current.has(selectionKey)) return;
    inFlight.current += 1;
    advice.current.set(selectionKey, { status: "loading" });
    repaint();
    suggestFor(view, selected)
      .then((suggestions) => advice.current.set(selectionKey, { status: "ready", suggestions }))
      .catch((error) =>
        advice.current.set(selectionKey, {
          status: "failed",
          message: String(error?.message ?? error),
        }),
      )
      .finally(() => {
        inFlight.current -= 1;
        repaint();
      });
  }, [selectionKey, view, selected, repaint]);

  useEffect(() => {
    if (!PREFETCH || selected.length < 2) return;
    if (advice.current.has(selectionKey)) return;
    const timer = setTimeout(() => {
      if (inFlight.current >= MAX_IN_FLIGHT) return;
      setSuggestionAt(0);
      askForSuggestions();
    }, SETTLE_MS);
    return () => clearTimeout(timer);
  }, [selectionKey, view, selected, askForSuggestions]);

  /**
   * Send what the reader typed, in whichever mode they typed it.
   *
   * Asking leaves the proposal alone and puts prose beside it. Amending replaces
   * the proposal in place and remembers what it replaced, so the pane can mark
   * what moved — that comparison is arithmetic over two changesets and is done
   * here rather than asked for.
   */
  const send = useCallback(
    async (kind: "ask" | "amend", text: string) => {
      const entry = advice.current.get(selectionKey);
      if (entry?.status !== "ready" || entry.suggestions.length === 0) return;
      const at = suggestionAt % entry.suggestions.length;
      const current = entry.suggestions[at]!;
      setMode({ name: "suggestions" });
      setWaiting(true);
      repaint();
      try {
        if (kind === "ask") {
          setAnswered({ question: text, answer: await askAbout(view, current, text) });
        } else {
          const revised = await amendWith(view, selected, current, text);
          if (!revised || !moved(current, revised)) {
            // Said rather than silently ignored, and said where the answer would
            // have gone: an instruction the proposal already satisfies is a real
            // outcome, and a screen that does not change after you press send
            // reads as a broken key.
            setAnswered({
              question: text,
              answer: "Nothing moved — the proposal already meets that.",
            });
          } else {
            const next = [...entry.suggestions];
            next[at] = revised;
            advice.current.set(selectionKey, { status: "ready", suggestions: next });
            setAmendedFrom(current);
            // The old answer was about the old proposal.
            setAnswered(undefined);
          }
        }
      } catch (error) {
        advice.current.set(selectionKey, {
          status: "failed",
          message: String((error as Error)?.message ?? error),
        });
      } finally {
        setWaiting(false);
        repaint();
      }
    },
    [selectionKey, suggestionAt, view, selected, repaint],
  );

  const moveCursor = useCallback(
    (delta: number) => {
      setMode({ name: "browsing" });
      // A new node has its own selections; 0 is the only one that always exists.
      setAsideIndex(0);
      // Nothing else is reset. Moving the cursor is not a decision about which
      // path you are on or how far a pane has scrolled, and resetting those made
      // an arrow press unrepeatable in reverse.
      const order = rendering.order;
      if (order.length === 0) return;
      const at = order.indexOf(cursorId);
      setCursorId(order[(Math.max(at, 0) + delta + order.length) % order.length]!);
    },
    [rendering, cursorId],
  );

  /**
   * Switching view keeps the node and changes the lens, which is the whole
   * contract of "for the focused node, show me ___".
   */
  const moveView = useCallback((delta: number) => {
    setMode({ name: "browsing" });
    // Selection, scroll and pane survive the switch, so tab and shift-tab put
    // you back exactly where you were.
    setViewId((current) => {
      const at = VIEWS.findIndex((each) => each.id === current);
      return VIEWS[(at + delta + VIEWS.length) % VIEWS.length]!.id;
    });
  }, []);

  const takeSuggestion = useCallback(
    async (suggestion: Suggestion) => {
      setMode({ name: "writing" });
      await applyChanges(config, view, suggestion.changes);
      setView(await readGraph(config));
      // The set described the old graph; a changeset that withdrew or added
      // nodes has made some of it meaningless, so it starts again.
      setSelected([]);
      setSelectedAt(0);
      advice.current.clear();
      setMode({ name: "browsing" });
    },
    [config, view],
  );

  const apply = useCallback(
    async (proposal: Proposal, chosen?: number) => {
      setMode({ name: "writing" });
      if (proposal.kind === "options") {
        const target = view.byId.get(proposal.nodeId);
        if (target) await writeStatement(target, proposal.options[chosen ?? 0]);
      } else {
        for (const edit of proposal.edits) {
          const target = view.byId.get(edit.id);
          if (target) await writeStatement(target, edit.to);
        }
      }
      // Re-read rather than patch in memory: the edit's real consequence is what
      // the linter now says about the nodes underneath, and only a re-read has it.
      setView(await readGraph(config));
      setMode({ name: "browsing" });
    },
    [config, view],
  );

  const total = Math.max(80, size.columns - 1);
  const sideWidth = Math.min(60, Math.max(30, Math.floor(total * 0.34)));
  const graphWidth = total - sideWidth - 2;

  /**
   * How many rows the footer will take, counted before the panes are sized.
   *
   * The frame must never be taller than the window. Ink erases the previous
   * frame by counting back over it, so a frame that overflows scrolls the top
   * away and leaves fragments behind that nothing will ever clear — the same
   * ghosting a resize causes. The panes give up rows to the footer rather than
   * the footer overrunning the screen.
   */
  const footerLines = (() => {
    if (mode.name === "writing") return 1;
    if (mode.name === "menu" && target) return actionsFor(target).length + 2;
    // A ready suggestion is drawn by the review pane, which measures itself.
    // The footer only carries the three states before one arrives.
    if (mode.name === "suggestions") return 1;
    if (mode.name === "acting") {
      if (!acting || acting.status === "loading") return 1;
      if (acting.status === "failed") return 2 + wrapText(acting.message, total, "").length;
      if (acting.proposal.kind === "options") {
        return (
          1 +
          acting.proposal.options.reduce(
            (rows, option) => rows + wrapText(option, total - 6, "").length,
            0,
          )
        );
      }
      return 2 + Math.min(acting.proposal.edits.length, editsToShow(size.rows)) * 3;
    }
    return 1;
  })();

  /**
   * The picked set costs rows, and the panes have to pay for them.
   *
   * They did not, and the frame grew past the bottom of the terminal every time
   * a node was picked: the top scrolled away and left fragments nothing would
   * clear, which is the same ghosting the alternate screen was brought in to
   * stop. The row count comes from `selectionRows` rather than being counted
   * again here, so the budget cannot drift from what actually gets drawn.
   */
  const group = useMemo(() => groupOf(view, selected), [view, selectionKey]);
  /**
   * The suggestion under review, or nothing.
   *
   * One value decides three things — which pane the bottom draws, whether the
   * breadcrumb appears, and how many rows the graph gives up — so they cannot
   * disagree about whether a review is happening.
   */
  const readySuggestions = suggested?.status === "ready" ? suggested.suggestions : [];
  const reviewing = underReview(mode.name, readySuggestions, suggestionAt);
  /** Marked in every view, so a pick is visible where you made it. */
  const pickedSet = useMemo(() => new Set(selected), [selectionKey]);
  // Wider while there is prose in it. An answer is several sentences and the
  // reader asked for them, so the graph gives up the rows rather than the answer
  // being clipped to fit a pane sized for a summary.
  const reviewCap = answered || mode.name === "talking" ? REVIEW_CAP + 6 : REVIEW_CAP;
  const selectionHeight =
    (selected.length > 0 ? selectionRows(group, SELECTION_CAP) : 0) +
    (reviewing ? reviewRows(view, reviewing, total, reviewCap, answered?.answer) : 0);
  // While reviewing, the pane above already carries the keys and the counter,
  // and the breadcrumb is hidden — so the footer costs nothing.
  const paneHeight = Math.max(8, size.rows - (reviewing ? 0 : footerLines + 1) - selectionHeight - 3);
  const sideItems = focus === "vocabulary" ? words.length : references.length;

  useInput((input, key) => {
    if (mode.name === "writing") return;

    /**
     * While the reader is typing, every key is a character.
     *
     * This sits above the `?` toggle and everything else on purpose: a question
     * containing a `?` is the ordinary case, and a guard that reached for the
     * key first would have eaten it out of the sentence.
     */
    if (mode.name === "talking") {
      if (key.escape) return setMode({ name: "suggestions" });
      if (key.tab) {
        return setMode({ ...mode, kind: mode.kind === "ask" ? "amend" : "ask" });
      }
      if (key.return) {
        const said = mode.text.trim();
        if (said.length === 0) return setMode({ name: "suggestions" });
        void send(mode.kind, said);
        return;
      }
      if (key.backspace || key.delete) {
        return setMode({ ...mode, text: mode.text.slice(0, -1) });
      }
      // Control sequences arrive as input too; only printable text is typing.
      if (input && !key.ctrl && !key.meta) {
        return setMode({ ...mode, text: mode.text + input });
      }
      return;
    }

    // Answered in every mode. The moment a reader most wants the list is when
    // they are somewhere they do not recognise, which is exactly where a guard
    // above would have swallowed the key.
    if (input === "?") return setShowKeys((open) => !open);

    if (mode.name === "suggestions") {
      const ready = suggested?.status === "ready" ? suggested.suggestions : [];
      if (ready.length === 0) return;
      const goDown = key.downArrow || input === "j";
      const goUp = key.upArrow || input === "k";
      if (key.escape) return setMode({ name: "browsing" });
      if (goDown || goUp) {
        setAnswered(undefined);
        setAmendedFrom(undefined);
        return setSuggestionAt((i) => (i + (goDown ? 1 : -1) + ready.length) % ready.length);
      }
      if (input === "/") return setMode({ name: "talking", kind: "ask", text: "" });
      if (input === "y") {
        const chosen = ready[suggestionAt % ready.length];
        if (chosen) void takeSuggestion(chosen);
      }
      return;
    }


    // Tab is the view switcher; panes move on the brackets. Views change what
    // you are looking at and panes only change what scrolls, so the bigger idea
    // gets the bigger key.
    if (key.tab) return moveView(key.shift ? -1 : 1);
    if (input === "[" || input === "]") {
      const panes = panesFor(rendering.aside.length > 0, selected.length > 0);
      const step = input === "]" ? 1 : -1;
      const at = Math.max(0, panes.indexOf(focus));
      return setFocus(panes[(at + step + panes.length) % panes.length]!);
    }

    const down = key.downArrow || input === "j";
    const up = key.upArrow || input === "k";
    if (down || up) {
      if (focus === "graph") return moveCursor(down ? 1 : -1);
      if (focus === "alternatives") {
        const count = Math.max(rendering.aside.length, 1);
        return setAsideIndex((i) => (i + (down ? 1 : -1) + count) % count);
      }
      if (focus === "selection") {
        const count = Math.max(selected.length, 1);
        return setSelectedAt((i) => (i + (down ? 1 : -1) + count) % count);
      }
      const pane = focus;
      const limit = Math.max(0, sideItems - 1);
      return setScroll((s) => ({
        ...s,
        [pane]: Math.max(0, Math.min(limit, s[pane] + (down ? 1 : -1))),
      }));
    }

    // In the alternatives pane the arrows page it, matching the way it is laid
    // out: the card sits between them. Cycling the path from in there would move
    // the ground under the thing being browsed.
    if (focus === "alternatives" && (key.leftArrow || key.rightArrow || input === "h" || input === "l")) {
      const count = Math.max(rendering.aside.length, 1);
      const step = key.rightArrow || input === "l" ? 1 : -1;
      return setAsideIndex((i) => (i + step + count) % count);
    }

    // Left and right cycle the selections the current view offers — the paths to
    // this node, in path view. Views with one selection ignore them.
    const total = Math.max(rendering.selections, 1);
    if (key.leftArrow || key.rightArrow || input === "h" || input === "l") {
      const next = (selection + (key.rightArrow || input === "l" ? 1 : -1) + total) % total;
      setSelection(next);
      // Carry the cursor to the same step of the new path. The swap preview
      // said which node would replace this one, so after the press the cursor
      // belongs on that node — leaving it behind put it on no card at all, and
      // then nothing on screen was marked as either cursor or anchor.
      const at = rendering.path.indexOf(cursorId);
      if (at >= 0) {
        const paths = pathsThrough(view, anchorId);
        const nextPath = paths[next % Math.max(paths.length, 1)];
        if (nextPath) setCursorId(nextPath[Math.min(at, nextPath.length - 1)]!);
      }
      return;
    }

    if (key.escape) {
      if (mode.name === "browsing") return exit();
      return setMode({ name: "browsing" });
    }

    // Ahead of the selection guard: quitting must not depend on having something
    // selected, or an empty graph would trap the reader.
    if (input === "q" && mode.name === "browsing") return exit();

    if (mode.name === "acting") {
      if (acting?.status !== "ready") return;
      if (acting.proposal.kind === "options") {
        const pick = Number(input);
        if (pick >= 1 && pick <= acting.proposal.options.length) {
          void apply(acting.proposal, pick - 1);
        }
        return;
      }
      if (input === "a") void apply(acting.proposal);
      return;
    }

    // Enter commits the highlighted alternative. Browsing the column is free;
    // moving the whole view onto one of them is deliberate, because it rebuilds
    // the path around the node you picked.
    if (key.return && focus === "selection") {
      const id = selected[selectedAt % Math.max(selected.length, 1)];
      if (!id) return;
      setFocus("graph");
      setCursorId(id);
      return setAnchorId(id);
    }

    if (key.return && focus === "alternatives") {
      const chosen = rendering.aside[asideIndex % Math.max(rendering.aside.length, 1)];
      if (!chosen) return;
      setAsideIndex(0);
      setSelection(0);
      setFocus("graph");
      setCursorId(chosen);
      return setAnchorId(chosen);
    }

    if (!target) return;

    // Enter means one thing in every pane: make what the cursor is on the
    // subject. In the alternatives pane that is the node you picked; here it is
    // re-drawing the view around where you have walked to. It has no inverse, so
    // it is a keypress rather than something an arrow does by accident.
    if (key.return) {
      setAsideIndex(0);
      return setAnchorId(cursorId);
    }

    // Space toggles the node under the cursor into the selection — the key every
    // file manager and mail client uses for exactly this, and now the most
    // frequent thing there is to do. The actions menu moved to `a` for it.
    if (input === " ") {
      const id = focus === "selection" ? selected[selectedAt % Math.max(selected.length, 1)] : cursorId;
      if (!id) return;
      setSelected((current) => {
        const next = current.includes(id) ? current.filter((each) => each !== id) : [...current, id];
        setSelectedAt((at) => Math.min(at, Math.max(next.length - 1, 0)));
        if (next.length === 0 && focus === "selection") setFocus("graph");
        return next;
      });
      return;
    }

    if (input === "a") return setMode({ name: "menu" });

    /**
     * The suggestions are about the set, so they are reached from the set.
     *
     * The key used to be ignored unless a reply had already arrived, which made
     * it dead in every case where nothing had been asked for: browsing with
     * prefetch off, or with fewer than two nodes picked. A key that does nothing
     * and says nothing is indistinguishable from a key that is broken, so it now
     * always opens the panel, and asks if nobody has asked yet.
     */
    if (input === "s") {
      setSuggestionAt(0);
      if (!suggested && selected.length >= 2) askForSuggestions();
      return setMode({ name: "suggestions" });
    }

    const action = actionByKey(target, input);
    if (action) {
      run(action, target);
      return setMode({ name: "acting", action });
    }
  });

  // --- layout ---------------------------------------------------------------
  // The viewport lives in the layout renderers now: each one scrolls on its own
  // terms, because a card grid, a tree, and a list of path steps do not share a
  // notion of "one row".

  // Two groups, because they are two kinds of thing. A definition is authored
  // knowledge; an undeclared noun is a finding about the words. The second gets
  // a heading that names it, and one compact line each — the same sentence
  // repeated down the pane was noise, not information.
  const declaredWords = words.filter((word) => word.declared);
  const undeclaredWords = words.filter((word) => !word.declared);
  const wordGroups: Group[] = [];
  if (declaredWords.length > 0) {
    wordGroups.push({
      key: "declared",
      items: declaredWords.map((word) => ({
        key: word.name,
        head: word.name,
        headColor: word.level ? levelColor(word.level) : undefined,
        definition: word.definition,
      })),
    });
  }
  if (undeclaredWords.length > 0) {
    const column = Math.max(...undeclaredWords.map((word) => word.name.length)) + 2;
    wordGroups.push({
      key: "undeclared",
      label: `no term defines ${undeclaredWords.length === 1 ? "this word" : "these words"}`,
      items: undeclaredWords.map((word) => ({
        key: word.name,
        head: word.name.padEnd(column),
        headDim: true,
        detail: `${word.spread?.uses ?? 0} uses, ${word.spread?.levels ?? 0} levels`,
      })),
    });
  }

  const referenceGroups: Group[] = references.length
    ? [
        {
          key: "references",
          items: references.map((reference) => ({
            key: reference.id,
            head: reference.kind,
            headColor: reference.kind === "mistake" ? SURFACE["reference.kind.mistake"] : undefined,
            headDim: reference.kind !== "mistake",
            definition: reference.statement,
          })),
        },
      ]
    : [];

  /**
   * Give each pane the room its content actually wants, and only ration when
   * the two together overflow. A fixed half each left the vocabulary pane
   * holding one line against twenty empty rows while the references pane
   * truncated a sentence — space reserved for nothing, beside content with
   * nowhere to go.
   */
  const keyState: KeyState = {
    mode: mode.name,
    reviewing: Boolean(reviewing),
    view: VIEWS.find((each) => each.id === viewId)?.label ?? viewId,
    paths: rendering.selections,
    pane: focus,
  };
  const screen = screenFor(keyState);
  /**
   * The guide is drawn whole or not at all.
   *
   * A half-listed set of keys is worse than none: the reader cannot tell whether
   * the key they wanted is missing or merely cut off, so they conclude it does
   * not exist. It is twenty-odd rows, which on a short terminal is more than the
   * side column has — so on a short terminal the column gives it everything and
   * the vocabulary and the references stand down. That is the right trade: those
   * two are about the path you are on and will still be there, while the guide
   * was asked for by name and is dismissed with the same key.
   */
  const room = paneHeight - 3;
  // Closed it is the spacer and its one line; open it is the whole guide. The
  // column pays for it either way, so opening the guide never reflows anything
  // above it — the rows come out of the vocabulary and the references, which is
  // where the reader is looking away from when they ask for the keys.
  // Whole or compact, never clipped: below a certain window the headings go so
  // that every key still fits. Only a window too short for even that can cut it.
  const compactKeys = keyRows(screen, keyState) + 1 > room;
  const keysWant = (showKeys ? keyRows(screen, keyState, compactKeys) : 1) + 1;
  const keysFit = keysWant <= room - 4;
  const keysHeight = Math.min(keysWant, room);
  const sideBudget = showKeys && !keysFit ? 0 : room - keysHeight;
  const wordsWant = naturalHeight(wordGroups, sideWidth);
  const referencesWant = naturalHeight(referenceGroups, sideWidth);
  let wordsBudget = wordsWant;
  let referencesBudget = referencesWant;
  if (wordsWant + referencesWant > sideBudget) {
    const floorFor = Math.min(4, Math.floor(sideBudget / 2));
    if (focus === "references") {
      referencesBudget = Math.max(floorFor, sideBudget - Math.min(wordsWant, floorFor));
      wordsBudget = sideBudget - referencesBudget;
    } else {
      wordsBudget = Math.min(wordsWant, Math.max(floorFor, sideBudget - floorFor));
      referencesBudget = sideBudget - wordsBudget;
    }
  }

  return (
    <Box flexDirection="column">
      {/* Anchored at the top. Below the panes it sat wherever the tallest view
          happened to end, so switching view moved it — and a label you have to
          re-find every time you switch is worse than no label. */}
      <Text wrap="truncate">
        {VIEWS.map((each) => (
          <Text key={each.id} bold={each.id === viewId} dimColor={each.id !== viewId}>
            {`${each.label}  `}
          </Text>
        ))}
      </Text>

      {/* A fixed height, so the breadcrumb and the footer below do not move
          either when one view draws fewer rows than another. */}
      <Box flexDirection="row" gap={2} height={paneHeight}>
        {/* whichever view is current draws the left column */}
        <Box flexDirection="column" width={graphWidth} flexShrink={0}>
          {/* No title here: each layout places its own heading, because only the
              layout knows what the heading is naming and where that sits. */}
          <LayoutView
            caption={focus === "alternatives" ? `${rendering.caption} · alternatives` : rendering.caption}
            paneFocused={focus === "graph" || focus === "alternatives"}
            view={view}
            layout={rendering.layout}
            focus={cursorId}
            anchor={anchorId}
            lit={onPath}
            width={graphWidth}
            height={paneHeight - 1}
            aside={rendering.aside}
            asideKinds={rendering.asideKinds}
            asideIndex={asideIndex}
            asideFocused={focus === "alternatives"}
            asideId={rendering.aside[asideIndex % Math.max(rendering.aside.length, 1)]}
            picked={pickedSet}
          />
        </Box>

        {/* vocabulary + references */}
        <Box flexDirection="column" width={sideWidth} flexShrink={0}>
          {sideBudget > 0 && (
            <>
              <Title text="vocabulary" focused={focus === "vocabulary"} />
              {wordGroups.length > 0 ? (
                <Entries
                  groups={wordGroups}
                  width={sideWidth}
                  budget={wordsBudget}
                  offset={scroll.vocabulary}
                />
              ) : (
                <Text dimColor>{"  no shared words on this path"}</Text>
              )}

              <Box height={1} />

              <Title text="references" focused={focus === "references"} />
              {referenceGroups.length > 0 ? (
                <Entries
                  groups={referenceGroups}
                  width={sideWidth}
                  budget={referencesBudget}
                  offset={scroll.references}
                />
              ) : (
                <Text dimColor>{"  none on this path"}</Text>
              )}
            </>
          )}

          {sideBudget > 0 && <Box height={1} />}
          {showKeys ? (
            <Keys screen={screen} state={keyState} width={sideWidth} compact={compactKeys} />
          ) : (
            <Text dimColor wrap="truncate">{"  ?  keyboard shortcuts"}</Text>
          )}
        </Box>
      </Box>

      {/* Reviewing replaces browsing at the bottom of the screen rather than
          stacking under it: the picked set is what the suggestion is ABOUT, so
          two panes would have shown the same nodes twice and paid rows for it. */}
      {selected.length > 0 && (
        <SelectionPanel
          view={view}
          group={group}
          picked={selected}
          focused={focus === "selection"}
          cursorAt={selectedAt}
          width={total}
          cap={SELECTION_CAP}
        />
      )}

      {/* Under the set it is about, not instead of it. Judging a suggestion
          means holding the claims it would change, and hiding them to save
          rows asked the reader to remember what they had just picked. */}
      {reviewing && (
        <ReviewPane
          suggestion={reviewing}
          at={suggestionAt % Math.max(readySuggestions.length, 1)}
          total={readySuggestions.length}
          view={view}
          width={total}
          cap={reviewCap}
          talking={mode.name === "talking" ? { kind: mode.kind, text: mode.text } : undefined}
          answered={answered}
          amendedFrom={amendedFrom}
          waiting={waiting}
        />
      )}

      {/* The breadcrumb names each step, not each level: two paths to the same
          node pass through the same six levels, so levels would read identical
          for every path and the one thing the line exists to show — which path
          you are on — would be invisible. Colour carries the level instead.
          
          It is hidden while reviewing. A chain of slugs is dense to read at the
          best of times, and beside prose written to be read it is noise
          competing for the same eye — the reviewer is deciding about claims,
          not navigating. */}
      {!reviewing && (
        <Text wrap="truncate">
          <Text color={SURFACE["breadcrumb.rail"]}>{`${GLYPH.railOn} `}</Text>
          {selectedPath.map((id, index) => (
            <Text key={id}>
              <Text color={levelColor(id.slice(0, id.indexOf(".")))} bold={index === selectedPath.length - 1}>
                {id.slice(id.indexOf(".") + 1)}
              </Text>
              <Text dimColor>{index < selectedPath.length - 1 ? ` ${GLYPH.step} ` : ""}</Text>
            </Text>
          ))}
        </Text>
      )}

      <Footer
        suggested={suggested}
        suggestionAt={suggestionAt}
        selectedCount={selected.length}
        view={view}
        mode={mode}
        acting={acting}
        selection={target}
        paths={rendering.selections}
        pathIndex={(selection % Math.max(rendering.selections, 1)) + 1}
        editsShown={editsToShow(size.rows)}
        keys={briefKeys(screen, keyState)}
      />
    </Box>
  );
}

function Footer({
  suggested,
  suggestionAt,
  selectedCount,
  mode,
  acting,
  selection,
  paths,
  pathIndex,
  view,
  editsShown,
  keys,
}: {
  suggested?: Suggested;
  suggestionAt: number;
  selectedCount: number;
  mode: Mode;
  acting?: Entry;
  selection?: Selection;
  paths: number;
  pathIndex: number;
  view: GraphView;
  editsShown: number;
  /** The one-line hint, built from the same table the guide draws. */
  keys: string;
}) {
  if (mode.name === "writing") return <Text>writing…</Text>;

  if (mode.name === "suggestions") {
    // Every state answers. The panel used to be reachable only when a reply had
    // arrived, so the three states before that had nothing to say and the key
    // that should have opened them did nothing at all.
    if (selectedCount < 2) {
      return <Text dimColor>{"  pick two or more nodes with ␣ — a suggestion is about a set"}</Text>;
    }
    if (!suggested) return <Text dimColor>{"  asking…"}</Text>;
    if (suggested.status === "loading") return <Text dimColor>{"  asking…"}</Text>;
    if (suggested.status === "failed") {
      return (
        <Text color={SURFACE["action.failed"]} wrap="truncate">{`  ${suggested.message}`}</Text>
      );
    }
    if (suggested.suggestions.length === 0) {
      return (
        <Text dimColor wrap="truncate">
          {"  nothing here is worth changing — these claims already sit well beside each other"}
        </Text>
      );
    }
    // Ready is the review pane's, above. Nothing to draw here.
    return null;
  }

  if (mode.name === "menu" && selection) {
    const available = actionsFor(selection);
    // Pad to the longest label so the hints form a column. Ragged second columns
    // are read as a list of unrelated things; an aligned one reads as a table of
    // choices, which is what this is.
    const gutter = Math.max(...available.map((action) => action.label.length)) + 2;
    const shape = shapeOf(selection);
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {shape === "path"
            ? `path selected · ${selection.path.length} nodes · ${paths} in all`
            : "node selected · nothing constrains it"}
        </Text>
        {available.map((action) => (
          <Text key={action.id} wrap="truncate">
            <Text bold>{`  ${action.key}  `}</Text>
            <Text bold>{action.label.padEnd(gutter)}</Text>
            <Text dimColor>{action.hint(selection)}</Text>
          </Text>
        ))}
        <Text dimColor>{"  esc  back"}</Text>
      </Box>
    );
  }

  if (mode.name === "acting") {
    if (!acting || acting.status === "loading") {
      return (
        <Text>
          {`${mode.action.label}…`}
          <Text dimColor>{"   esc cancel"}</Text>
        </Text>
      );
    }
    if (acting.status === "failed") {
      return (
        <Box flexDirection="column">
          <Text color={SURFACE["action.failed"]}>{acting.message}</Text>
          <Text dimColor>esc back</Text>
        </Box>
      );
    }
    const proposal = acting.proposal;
    if (proposal.kind === "options") {
      return (
        <Box flexDirection="column">
          {proposal.options.map((option, index) => (
            <Text key={option} wrap="truncate">
              <Text bold>{`  ${index + 1}  `}</Text>
              {option}
            </Text>
          ))}
          <Text dimColor>{`  1-${proposal.options.length} accept   esc cancel`}</Text>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {proposal.edits.length > editsShown
            ? `${proposal.edits.length} statements change, showing ${editsShown}`
            : `${proposal.edits.length} statement(s) change`}
        </Text>
        {proposal.edits.slice(0, editsShown).map((edit) => (
          <Box key={edit.id} flexDirection="column">
            <Text color={levelColor(edit.id.split(".")[0])} wrap="truncate">
              {`  ${edit.id}`}
            </Text>
            <Text dimColor wrap="truncate">{`   ${GLYPH.was} ${edit.from}`}</Text>
            <Text color={SURFACE["edit.becomes"]} wrap="truncate">{`   ${GLYPH.becomes} ${edit.to}`}</Text>
          </Box>
        ))}
        <Text dimColor>{"  a accept all   esc cancel"}</Text>
      </Box>
    );
  }

  return (
    <Text wrap="truncate">
      <Text color={statusColor(view)}>{view.status}</Text>
      {/* A refused key is said once, here, rather than as a raw 401 where a
          suggestion should have been. The editor carries on either way. */}
      {apiNote() && <Text color={SURFACE["action.failed"]}>{`   ${apiNote()}`}</Text>}
      <Text dimColor>{paths > 1 ? `   ${pathIndex}/${paths}` : ""}</Text>
      {selectedCount > 0 && (
        <Text dimColor>
          {suggested?.status === "ready"
            ? `   ${selectedCount} picked · s for suggestions`
            : suggested?.status === "loading"
              ? `   ${selectedCount} picked · thinking…`
              : `   ${selectedCount} picked`}
        </Text>
      )}
      {/* From the same table the guide draws, so the line cannot describe a key
          the editor no longer has — which is how it came to omit `s`. */}
      <Text dimColor>{`   ${keys}`}</Text>
    </Text>
  );
}
