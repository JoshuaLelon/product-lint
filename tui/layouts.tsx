/**
 * Drawing the three layouts the five views produce.
 *
 * Every view draws its nodes as cards. One renderer builds them, so a node looks
 * the same whether it sits in a level's grid, hangs off a tree, or stacks in a
 * path — and because the card is built as strings rather than with Ink's
 * `borderStyle`, a tree can put connector characters in the margin beside every
 * row of it, which a bordered Box owning its own edges could not do.
 *
 * Kept apart from `app.tsx` so that adding a sixth view is a question about
 * which nodes to pick and how to arrange them, not a question about state or
 * keys.
 */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { GLYPH, LEVEL, SURFACE } from "./theme.js";
import { describe, type Grouping } from "./selection.js";
import type { GraphView } from "./graph.js";
import type { Band, Layout, PathStep, TreeRow } from "./views.js";
import type { KnowledgeLevel } from "../src/types.js";

const levelColor = (level: string): string | undefined => LEVEL[level as KnowledgeLevel];

export interface LayoutProps {
  view: GraphView;
  layout: Layout;
  focus: string;
  lit: Set<string>;
  width: number;
  height: number;
  /** The alternative under the cursor, when the alternatives pane has focus. */
  asideId?: string;
  /** The alternatives to this step, and the group heading for each. */
  aside: string[];
  asideKinds: string[];
  asideIndex: number;
  asideFocused: boolean;
  /** What the view is showing, for the layout to place. */
  caption: string;
  /** Whether this pane takes the arrow keys. */
  paneFocused: boolean;
  /** The node the view is built from — what the selections cycle around. */
  anchor: string;
  /** The picked set, marked in every view so a pick is visible where you made it. */
  picked: Set<string>;
}

/**
 * A heading, placed by the layout rather than by the app.
 *
 * The app used to draw one title above every pane, which put level view's label
 * at the top of the column — above the list of the level ABOVE, where it read as
 * that list's heading. A heading has to sit against the thing it names, and only
 * the layout knows where that is.
 */
function Heading({
  text,
  focused,
  colour,
  note,
}: {
  text: string;
  focused: boolean;
  colour?: string;
  /** Said quietly after the heading — the anchor, when it is worth naming. */
  note?: string;
}) {
  return (
    <Text wrap="truncate">
      <Text dimColor={!focused} bold={focused} color={colour}>
        {`${focused ? GLYPH.railOn : GLYPH.railOff} ${text.toUpperCase()}`}
      </Text>
      {note && <Text dimColor>{`   anchored at ${note}`}</Text>}
    </Text>
  );
}

/** The readable half of an id, for saying which node without the level prefix. */
function slugOf(id: string): string {
  return id.slice(id.indexOf(".") + 1);
}

function levelOf(view: GraphView, id: string): string {
  return view.byId.get(id)?.level ?? id.slice(0, id.indexOf("."));
}

/** Every line the text needs at this width, uncapped. */
function wrapAll(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.length > 0 ? out : [""];
}

/**
 * How many rows a card must be to show a statement whole.
 *
 * Cards used a fixed two lines and clipped whatever did not fit, which threw
 * away the end of most statements while the screen sat half empty. A card asks
 * for what it needs; only the height budget shortens it.
 */
export function linesFor(text: string, cardWidth: number): number {
  return wrapAll(text, Math.max(4, cardWidth - 4)).length;
}

/** Wrap to a fixed number of lines, padding short text so a card stays square. */
function wrap(text: string, width: number, lines: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && `${line} ${word}`.length > width) {
      out.push(line);
      line = word;
      if (out.length === lines) break;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (out.length < lines && line) out.push(line);
  while (out.length < lines) out.push("");
  if (out.join(" ").trim().length < text.trim().length) {
    out[lines - 1] = `${out[lines - 1]!.slice(0, Math.max(0, width - 1)).trimEnd()}…`;
  }
  return out;
}

/**
 * A node as a card: a border, and the statement inside it.
 *
 * The focused card takes the heavy border — structure rather than colour, so it
 * still reads as focused whether or not it is also on the selection.
 */
/**
 * The legend as it will actually be drawn, shortened rather than dropped.
 *
 * A card too narrow for `ARCHITECTURE` used to print no level at all, which
 * broke the rule everywhere it mattered most: the previews are the cards whose
 * level you cannot infer from anywhere else, and they are also the narrowest.
 * `ARCH…` says the level; nothing says nothing.
 *
 * Exported because `Card` has to tint the label, and to do that it must know
 * which characters ended up in the border — asking the same function is what
 * keeps the two from disagreeing about it.
 */
export function fitLegend(legend: string | undefined, inner: number): string | undefined {
  if (!legend) return undefined;
  if (inner >= legend.length + 4) return legend;
  const room = inner - 5;
  return room >= 3 ? `${legend.slice(0, room)}…` : undefined;
}

export function cardRows(
  text: string,
  width: number,
  lines: number,
  focused: boolean,
  legend?: string,
): string[] {
  const inner = Math.max(4, width - 4);
  const bar = focused ? "━" : "─";
  const side = focused ? "┃" : "│";
  const [tl, tr, bl, br] = focused ? ["┏", "┓", "┗", "┛"] : ["╭", "╮", "╰", "╯"];
  // The legend rides in the top border, so naming the level costs no row. It
  // has to be told: on a selected path every card wears the selection colour,
  // which paints straight over the level ramp and leaves no level signal at all.
  //
  // One rule decides who asks for it: a card carries its level when its position
  // does not already say it. In a tree it must — depth is distance from the node
  // you are on, not stratum, and the two come apart as soon as a parent has a
  // parent. In a path and among alternatives it must, for the same reason. In
  // the level grid it must not: the heading directly above the grid names the
  // level once for every card under it, and sixteen cards repeating it is noise,
  // not consistency.
  const shown = fitLegend(legend, inner);
  const top = shown
    ? `${tl}${bar}${bar} ${shown} ${bar.repeat(inner - shown.length - 2)}${tr}`
    : tl + bar.repeat(inner + 2) + tr;
  return [
    top,
    ...wrap(text, inner, lines).map((line) => `${side} ${line.padEnd(inner)} ${side}`),
    bl + bar.repeat(inner + 2) + br,
  ];
}

export const cardHeight = (lines: number) => lines + 2;

function Card({
  view,
  id,
  focused,
  lit,
  width,
  lines,
  prefix,
  cont,
  note,
  legend,
  anchored,
  picked,
}: {
  view: GraphView;
  id: string;
  focused: boolean;
  lit: boolean;
  width: number;
  lines: number;
  /** Drawn in the margin beside the card's first row. */
  prefix?: string;
  /** Drawn beside every row after the first. */
  cont?: string;
  note?: string;
  legend?: string;
  /** The view is built from this node, though the cursor has moved elsewhere. */
  anchored?: boolean;
  /** In the picked set — independent of where the cursor is. */
  picked?: boolean;
}) {
  const colour = lit ? SURFACE["graph.rail.onPath"] : levelColor(levelOf(view, id));
  const text = note ?? view.byId.get(id)?.statement ?? id;
  const margin = prefix !== undefined || cont !== undefined;
  // The legend is level information, so it takes the level's colour — never the
  // card's. A card on the selected path is amber all over, and a level label
  // painted in the selection hue both disappears into the border and says the
  // wrong thing on the wrong channel.
  // Lowercased before the lookup, because the ramp is keyed by the level's own
  // spelling. Two callers passed a legend already uppercased, so `levelColor`
  // missed and their labels came out uncoloured while the identical label in
  // path view was tinted — the same meaning painted two ways on two screens,
  // which is the thing SURFACE exists to prevent.
  // What the border will actually show, asked of the same function that draws
  // it — a narrow card shortens the legend, and tinting the untruncated text
  // would find nothing and leave the label uncoloured.
  const label = fitLegend(legend?.toUpperCase(), Math.max(4, width - 2 - 4));
  const labelColour = legend ? levelColor(legend.toLowerCase()) : undefined;
  return (
    <Box flexDirection="column">
      {cardRows(text, width - 2, lines, focused, label).map((row, index) => {
        const cut = index === 0 && label ? row.indexOf(label) : -1;
        return (
          <Text key={index} wrap="truncate">
            {margin && <Text dimColor>{index === 0 ? (prefix ?? "") : (cont ?? "")}</Text>}
            {/* Two reserved columns, because they answer independent
                questions. The first is where you are: solid at the cursor,
                dashed where the view is anchored. The second is whether this
                node is in the picked set, which is true or false regardless of
                where the cursor happens to be. */}
            <Text color={SURFACE["graph.cursor"]} bold={focused} dimColor={!focused}>
              {focused ? GLYPH.here : anchored ? GLYPH.anchor : " "}
            </Text>
            <Text bold={picked} dimColor={!picked}>
              {picked ? GLYPH.picked : " "}
            </Text>
            {cut > 0 ? (
              <>
                <Text color={colour} bold={focused} dimColor={!lit && !focused}>
                  {row.slice(0, cut)}
                </Text>
                <Text color={labelColour} bold>
                  {label}
                </Text>
                <Text color={colour} bold={focused} dimColor={!lit && !focused}>
                  {row.slice(cut + label!.length)}
                </Text>
              </>
            ) : (
              <Text color={colour} bold={focused} dimColor={!lit && !focused}>
                {row}
              </Text>
            )}
          </Text>
        );
      })}
    </Box>
  );
}

/** A neighbouring level, listed rather than drawn: you glance at these. */
function List({
  view,
  band,
  focus,
  lit,
  budget,
  anchor,
  paneFocused,
  picked,
}: {
  view: GraphView;
  band: Band;
  focus: string;
  lit: Set<string>;
  budget: number;
  anchor: string;
  paneFocused: boolean;
  picked: Set<string>;
}) {
  // Connected nodes first. Alphabetical order hid the very thing the band exists
  // to show: a node whose two children sorted late read as having none, because
  // both fell past the cap into "… 9 more".
  const ordered = [...band.ids].sort((left, right) =>
    Number(lit.has(right)) - Number(lit.has(left)),
  );
  const connected = band.ids.filter((id) => lit.has(id)).length;
  return (
    <Box flexDirection="column">
      {/* The rail says which pane takes the arrows, the same as every other
          heading. These lists alone drew the light rail always, so the level
          view was the one screen where focus was invisible. */}
      <Text dimColor bold color={levelColor(band.level)}>
        {`${paneFocused ? GLYPH.railOn : GLYPH.railOff} ${band.level}`}
        <Text dimColor>{connected > 0 ? `   ${connected} connected` : "   none connected"}</Text>
      </Text>
      {ordered.slice(0, budget).map((id) => {
        const on = lit.has(id);
        return (
          <Text key={id} wrap="truncate">
            <Text color={on ? SURFACE["graph.rail.onPath"] : levelColor(band.level)} dimColor={!on}>
              {on ? GLYPH.railOn : GLYPH.railOff}
            </Text>
            {/* The same gutter a card uses, so "where you are" and "where the
                view is rooted" look the same in a list as in a grid. This list
                drew a different glyph for the cursor and drew nothing at all for
                the anchor, so moving between panes changed what the marks meant. */}
            <Text color={SURFACE["graph.cursor"]} bold={id === focus} dimColor={id !== focus}>
              {id === focus ? GLYPH.here : id === anchor ? GLYPH.anchor : " "}
            </Text>
            <Text bold={picked.has(id)} dimColor={!picked.has(id)}>
              {picked.has(id) ? GLYPH.picked : " "}
            </Text>
            <Text dimColor={!on} color={on ? SURFACE["graph.statement.onPath"] : undefined}>
              {` ${view.byId.get(id)?.statement ?? id}`}
            </Text>
          </Text>
        );
      })}
      <Text dimColor>{ordered.length > budget ? `  … ${ordered.length - budget} more` : " "}</Text>
    </Box>
  );
}

/** Level view: the level you are on as a grid of cards, its neighbours as lists. */
function Bands({ view, bands, focus, lit, width, height, paneFocused, anchor, picked }: LayoutProps & { bands: Band[] }) {
  const current = bands.find((band) => band.current);
  const above = bands[0]?.current ? undefined : bands[0];
  const below = bands.find((band) => band !== above && !band.current);

  const cardWidth = Math.min(38, Math.max(24, Math.floor(width / 3) - 2));
  const perRow = Math.max(1, Math.floor(width / (cardWidth + 2)));
  const cards = current?.ids ?? [];

  const rowHeight = cardHeight(3);
  const neighbours = [above, below].filter(Boolean).length;
  // Neighbours are capped hard rather than given an equal share: an even split
  // gave one list twenty-five rows and the cards one, which inverts the view.
  const listBudget = Math.max(1, Math.min(4, Math.floor(height / 8)));
  const spent = neighbours * (listBudget + 2) + 1;
  const cardRowCount = Math.max(1, Math.floor((height - spent) / rowHeight));

  const focusRow = Math.floor(Math.max(0, cards.indexOf(focus)) / perRow);
  const totalRows = Math.ceil(cards.length / perRow);
  const firstRow = Math.max(
    0,
    Math.min(focusRow - Math.floor(cardRowCount / 2), totalRows - cardRowCount),
  );
  const visible = cards.slice(firstRow * perRow, (firstRow + cardRowCount) * perRow);

  const grid: string[][] = [];
  for (let index = 0; index < visible.length; index += perRow) {
    grid.push(visible.slice(index, index + perRow));
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      {above && <List view={view} band={above} focus={focus} lit={lit} budget={listBudget} anchor={anchor} paneFocused={paneFocused} picked={picked} />}

      {/* The level's name sits directly on top of its own cards. */}
      <Text>
        <Heading
          text={current?.level ?? ""}
          focused={paneFocused}
          colour={levelColor(current?.level ?? "")}
          note={anchor === focus ? undefined : slugOf(anchor)}
        />
        <Text dimColor>
          {cards.length > visible.length ? `   ${visible.length} of ${cards.length}` : ""}
        </Text>
      </Text>
      {grid.map((rowIds) => (
        <Box key={rowIds.join()} flexDirection="row" gap={2}>
          {rowIds.map((id) => (
            <Box key={id} flexDirection="column" width={cardWidth}>
              <Card
                view={view}
                id={id}
                focused={id === focus}
                anchored={id === anchor}
                picked={picked.has(id)}
                lit={lit.has(id)}
                width={cardWidth}
                lines={3}
              />
            </Box>
          ))}
        </Box>
      ))}

      {below && <List view={view} band={below} focus={focus} lit={lit} budget={listBudget} anchor={anchor} paneFocused={paneFocused} picked={picked} />}
    </Box>
  );
}

/** Tree view: cards hanging off connectors, with re-entries marked. */
function Tree({ view, rows, focus, lit, width, height, paneFocused, anchor, caption, picked }: LayoutProps & { rows: TreeRow[] }) {
  const LINES = 2;
  const costOf = (row: TreeRow) => (row.kind === "label" ? 1 : cardHeight(LINES));
  // One row goes to the heading, so the window must not budget for it twice.
  const room = height - 1;

  // Window on the focused CARD, not on a row count: a card is four rows tall, so
  // counting rows would scroll straight past the thing being looked at.
  const focusAt = rows.findIndex((row) => row.kind === "node" && row.id === focus && !row.reentry);
  let start = 0;
  while (start < focusAt) {
    let used = 0;
    let reached = false;
    for (let index = start; index < rows.length; index++) {
      used += costOf(rows[index]!);
      if (used > room - 1) break;
      if (index === focusAt) {
        reached = true;
        break;
      }
    }
    if (reached) break;
    start += 1;
  }

  const shown: TreeRow[] = [];
  let spent = 0;
  for (const row of rows.slice(start)) {
    const cost = costOf(row);
    if (shown.length > 0 && spent + cost > room - 1) break;
    shown.push(row);
    spent += cost;
  }

  // Each card is sized to what its own indent leaves, so every card ends at the
  // same column however deep it sits. A single width for all of them made the
  // right edge step outward with depth, which read as ragged rather than nested.
  const roomFor = (prefix: string) => Math.max(20, width - prefix.length - 1);

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Tree views were the only ones drawing no heading, so they alone never
          said which pane had the arrows or where the view was anchored. */}
      <Heading
        text={caption}
        focused={paneFocused}
        note={anchor === focus ? undefined : slugOf(anchor)}
      />
      {shown.map((row, index) =>
        row.kind === "label" ? (
          <Text key={`label-${index}`} dimColor wrap="truncate">
            {`${paneFocused ? GLYPH.railOn : GLYPH.railOff} ${row.text}`}
          </Text>
        ) : (
          <Card
            key={`${row.id}-${index}`}
            view={view}
            id={row.id}
            focused={row.id === focus && !row.reentry}
            anchored={row.id === anchor && !row.reentry}
            picked={picked.has(row.id) && !row.reentry}
            lit={lit.has(row.id) && !row.reentry}
            width={roomFor(row.prefix)}
            lines={LINES}
            prefix={row.prefix}
            cont={row.cont}
            // The level, at the head of the card, the same way path view does
            // it. In an indented tree it is the one thing you cannot infer from
            // position: depth is how far the claim is from the node you are on,
            // not which stratum it belongs to, and the two come apart the moment
            // a parent has a parent.
            legend={row.reentry ? undefined : levelOf(view, row.id)}
            note={
              row.reentry
                ? `${GLYPH.reentry} ${view.byId.get(row.id)?.statement ?? row.id}  (shown above)`
                : undefined
            }
          />
        ),
      )}
      {rows.length - start - shown.length > 0 && (
        <Text dimColor>{`  … ${rows.length - start - shown.length} more`}</Text>
      )}
    </Box>
  );
}

/**
 * Path view: the path as a chain of cards, what it passed over on the right.
 *
 * Each step gets a block tall enough for its own alternatives, so the two
 * columns stay level. The alternatives are split in two because they answer
 * different questions: what else this same constraint produced, and what else
 * the level says at all.
 */
/**
 * Path view: the line down the middle, what it passed over on either side.
 *
 * Three columns of FIXED width, every step the same. Sizing the middle card to
 * whatever space its own previews left over made each step a different width,
 * so the path zig-zagged down the screen and nothing lined up; the slots are
 * reserved whether or not a step has anything to put in them.
 *
 * The alternatives column is offset to start level with the step the cursor is
 * on. An alternative is a node at that step's level, so standing it at the top
 * of its own column divorced it from the thing it was an alternative to.
 */
function PathLayout({
  view,
  steps,
  focus,
  lit,
  width,
  height,
  aside,
  asideKinds,
  asideIndex,
  caption,
  paneFocused,
  asideFocused,
  anchor,
  picked,
}: LayoutProps & { steps: PathStep[] }) {
  // Reserve both side slots or neither, so every middle card is the same width
  // and sits in the same place.
  const asideWidth = Math.max(30, Math.min(46, Math.floor(width * 0.3)));
  const left = width - asideWidth - 2;
  const previewWidth = Math.max(18, Math.min(28, Math.floor(left * 0.24)));
  const roomy = left - 2 * (previewWidth + 1) >= 34;
  const mainWidth = roomy ? left - 2 * (previewWidth + 1) : left;

  const statementOf = (id: string) => view.byId.get(id)?.statement ?? id;
  // A row is as tall as the tallest card in it, so the three stay level. Each
  // asks for the rows its text needs; only the budget below shortens anything.
  const linesOf = (step: PathStep) =>
    Math.max(
      2,
      linesFor(statementOf(step.id), mainWidth),
      ...(roomy
        ? [step.swapPrev, step.swapNext]
            .filter((id): id is string => Boolean(id))
            .map((id) => linesFor(statementOf(id), previewWidth))
        : [0]),
    );

  const focusStep = Math.max(0, steps.findIndex((step) => step.id === focus));
  const budget = height - 1;

  // Grow every step to its full height, then take neighbours outward from the
  // cursor's step while they still fit, so the cursor is always inside the run.
  const heights = steps.map((step) => cardHeight(linesOf(step)) + 1);
  let first = focusStep;
  let last = focusStep;
  let used = heights[focusStep] ?? 0;
  for (;;) {
    const before = first > 0 ? heights[first - 1]! : Number.POSITIVE_INFINITY;
    const after = last < steps.length - 1 ? heights[last + 1]! : Number.POSITIVE_INFINITY;
    if (before <= after && used + before <= budget) {
      first -= 1;
      used += before;
    } else if (after < Number.POSITIVE_INFINITY && used + after <= budget) {
      last += 1;
      used += after;
    } else break;
  }
  const start = first;
  const shown = steps.slice(first, last + 1);

  const Mini = ({
    id,
    arrow,
    side,
    lines,
  }: { id: string; arrow: string; side: "left" | "right"; lines: number }) => {
    const level = levelOf(view, id);
    const label = fitLegend(level.toUpperCase(), Math.max(4, previewWidth - 4));
    return (
      <Box flexDirection="column">
        {cardRows(statementOf(id), previewWidth, lines, false, label).map(
          (row, index) => {
            const cut = index === 0 && label ? row.indexOf(label) : -1;
            // Dim throughout, arrow included. A preview is something to glance
            // at, and a bold level label made it read as loud as the path itself.
            const arrowCell = (
              <Text color={SURFACE["graph.cursor"]} dimColor>
                {index === 1 ? arrow : " "}
              </Text>
            );
            return (
              <Text key={index} wrap="truncate">
                {side === "left" && arrowCell}
                {cut > 0 ? (
                  <>
                    <Text dimColor>{row.slice(0, cut)}</Text>
                    <Text color={levelColor(level)} dimColor>
                      {label}
                    </Text>
                    <Text dimColor>{row.slice(cut + label!.length)}</Text>
                  </>
                ) : (
                  <Text dimColor>{row}</Text>
                )}
                {side === "right" && arrowCell}
              </Text>
            );
          },
        )}
      </Box>
    );
  };

  return (
    <Box flexDirection="column" width={width} height={height}>
      {/* Naming the anchor answers "cycling around what?" — the paths are the
          paths through that node, and the cursor may have walked away from it. */}
      <Heading
        text={caption}
        focused={paneFocused && !asideFocused}
        note={anchor === focus ? undefined : slugOf(anchor)}
      />
      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column" width={left} flexShrink={0}>
          {shown.map((step, index) => {
            // A card sits on the side its arrow points from. With only two paths
            // both arrows reach the same node, so one card carries a two-headed
            // arrow rather than two cards implying a choice that is not there.
            const back = step.swapPrev;
            const forward = step.swapNext;
            const same = Boolean(back && forward && back === forward);
            const leftMini = same ? undefined : back;
            const rightMini = same ? back : forward;
            const lines = linesOf(step);
            return (
              <Box key={step.id} flexDirection="column">
                {/* The stub joins one card to the next, so it lines up with the
                    cards rather than with the edge of the pane. */}
                <Text color={SURFACE["graph.rail.onPath"]}>
                  {index > 0 || start > 0
                    ? `${" ".repeat(roomy ? previewWidth + 4 : 2)}${GLYPH.stubUp}`
                    : " "}
                </Text>
                <Box flexDirection="row" gap={1}>
                  {roomy && (
                    <Box width={previewWidth + 1} flexShrink={0}>
                      {leftMini && <Mini id={leftMini} arrow="←" side="left" lines={lines} />}
                    </Box>
                  )}
                  <Box flexDirection="column" width={mainWidth} flexShrink={0}>
                    <Card
                      view={view}
                      id={step.id}
                      focused={step.id === focus}
                      anchored={step.id === anchor}
                      picked={picked.has(step.id)}
                      lit={lit.has(step.id)}
                      width={mainWidth}
                      lines={lines}
                      legend={levelOf(view, step.id)}
                    />
                  </Box>
                  {roomy && (
                    <Box width={previewWidth + 1} flexShrink={0}>
                      {rightMini && (
                        <Mini id={rightMini} arrow={same ? "↔" : "→"} side="right" lines={lines} />
                      )}
                    </Box>
                  )}
                </Box>
              </Box>
            );
          })}
          {steps.length > shown.length && (
            <Text dimColor>{`  … ${steps.length - shown.length} more steps`}</Text>
          )}
        </Box>

        <Alternatives
          view={view}
          ids={aside}
          kinds={asideKinds}
          index={asideIndex}
          width={asideWidth}
          budget={budget}
          focused={asideFocused}
          // Level with the step it belongs to: two rows above that step's card
          // leaves room for this column's own heading and its previous peek.
          lead={Math.max(0, heights.slice(first, focusStep).reduce((a, b) => a + b, 0))}
        />
      </Box>
    </Box>
  );
}

/**
 * The nodes this step passed over — one at a time, with the arrows either side.
 *
 * Laid out the way it is paged: the card between two arrows, the counts saying
 * how many lie each way. A stacked list of clipped lines showed that fifteen
 * things existed and let you read none of them, and a bare "↓" beside a sentence
 * named nothing at all.
 *
 * The heading names what the card IS to the step — a sibling shares its parent,
 * a cousin only shares its level — and how many more of that same kind follow.
 */
function Alternatives({
  view,
  ids,
  kinds,
  index,
  width,
  budget,
  focused,
  lead,
}: {
  view: GraphView;
  ids: string[];
  kinds: string[];
  index: number;
  width: number;
  /** Rows this column may use in total, once its lead is spent. */
  budget: number;
  focused: boolean;
  lead: number;
}) {
  const blanks = Array.from({ length: lead }, (_, row) => <Text key={`gap-${row}`}> </Text>);

  if (ids.length === 0) {
    return (
      <Box flexDirection="column" width={width} flexShrink={0}>
        {blanks}
        <Heading text="alternatives" focused={focused} />
        <Text dimColor>{"  no siblings, no cousins"}</Text>
      </Box>
    );
  }

  const at = ((index % ids.length) + ids.length) % ids.length;
  const id = ids[at]!;
  const statementOf = (node: string) => view.byId.get(node)?.statement ?? node;
  const kind = kinds[at] ?? "";
  const behind = at;
  const ahead = ids.length - 1 - at;
  // How many more of this same kind are still ahead, which is what tells you
  // whether the next press is another sibling or the first cousin.
  const more = kinds.slice(at + 1).filter((each) => each === kind).length;

  const rail = 6;
  const cardWidth = Math.max(18, width - rail * 2);
  // As many rows as the statement needs, less what the lead and the heading have
  // already spent. Only a genuinely full column shortens it.
  const lines = Math.max(2, Math.min(linesFor(statementOf(id), cardWidth), budget - lead - 3));
  const rows = cardHeight(lines);
  const middle = 1;

  /** One arrow and its count, level with the middle of the card. */
  const Side = ({ count, arrow, side }: { count: number; arrow: string; side: "left" | "right" }) => (
    <Box flexDirection="column" width={rail} flexShrink={0}>
      {Array.from({ length: rows }, (_, row) => (
        <Text key={row} dimColor wrap="truncate">
          {row !== middle
            ? " "
            : side === "left"
              ? `${String(count).padStart(3)} ${arrow}`
              : `${arrow} ${String(count).padEnd(3)}`}
        </Text>
      ))}
    </Box>
  );

  return (
    <Box flexDirection="column" width={width} flexShrink={0}>
      {blanks}
      <Heading text={more > 0 ? `${kind} (${more} more)` : kind} focused={focused} />
      <Box flexDirection="row">
        <Side count={behind} arrow="←" side="left" />
        <Box flexDirection="column" width={cardWidth} flexShrink={0}>
          <Card
            view={view}
            id={id}
            focused={focused}
            lit={false}
            width={cardWidth}
            lines={lines}
            legend={levelOf(view, id)}
          />
        </Box>
        <Side count={ahead} arrow="→" side="right" />
      </Box>
    </Box>
  );
}

/**
 * The picked set, drawn as whatever shape the graph says it has.
 *
 * One row per node rather than a card apiece: this is a strip along the bottom
 * competing with the graph for rows, and four-row cards would let three picks
 * take half the screen. The structure is carried by connectors and by a box,
 * which cost one column and two rows — the graphical part is the shape, not the
 * size of the thing drawn.
 */
export function SelectionPanel({
  view,
  group,
  picked,
  focused,
  cursorAt,
  width,
  cap,
}: {
  view: GraphView;
  group: Grouping;
  picked: string[];
  focused: boolean;
  /** Which of the picked nodes the selection pane's cursor is on. */
  cursorAt: number;
  width: number;
  cap: number;
}) {
  const chosen = new Set(picked);
  const at = picked[cursorAt % Math.max(picked.length, 1)];
  const shown = group.ids.slice(0, cap);
  const hidden = group.ids.length - shown.length;

  /**
   * One node: the gutter, its level where that is not already said, and as much
   * of the statement as fits.
   *
   * `edge` closes a box the caller opened, so the statement is padded to an
   * exact column rather than left to run into the border. `level` is dropped
   * inside a box that already names the level — the same rule the card legend
   * follows, since a box saying PRODUCT over three rows saying PRODUCT is the
   * heading repeated, not structure.
   */
  const Row = ({
    id,
    indent,
    showLevel = true,
    edge,
  }: { id: string; indent: string; showLevel?: boolean; edge?: string }) => {
    const node = view.byId.get(id);
    const level = levelOf(view, id);
    // A step on the line nobody picked is WHY the picked ones are related, so it
    // is drawn — but dim, so it never reads as something you chose.
    const isPicked = chosen.has(id);
    const here = focused && id === at;
    const spent = 1 + indent.length + (showLevel ? 14 : 1) + (edge ? edge.length : 0);
    const room = Math.max(12, width - spent);
    const text = (node?.statement ?? id).slice(0, room);
    return (
      <Text wrap="truncate">
        <Text color={SURFACE["graph.cursor"]} bold={here} dimColor={!here}>
          {here ? GLYPH.here : " "}
        </Text>
        <Text dimColor>{indent}</Text>
        {showLevel ? (
          <Text color={levelColor(level)} bold={isPicked} dimColor={!isPicked}>
            {` ${level.toUpperCase().padEnd(13)}`}
          </Text>
        ) : (
          <Text>{" "}</Text>
        )}
        <Text bold={here} dimColor={!isPicked}>
          {edge ? text.padEnd(room) : text}
        </Text>
        {edge && <Text color={levelColor(level)} dimColor>{edge}</Text>}
      </Text>
    );
  };

  return (
    <Box flexDirection="column">
      <Heading text={describe(group, picked.length)} focused={focused} />

      {group.kind === "siblings" && (
        <>
          <Row id={group.parent} indent="" />
          {shown.map((id, index) => (
            <Row key={id} indent={index === shown.length - 1 && hidden === 0 ? " └─" : " ├─"} id={id} />
          ))}
        </>
      )}

      {group.kind === "level" && (
        <>
          {/* One box holding the whole stratum, because that is what they share:
              no claim above them all, just the same place in the graph. The box
              names the level once, so the rows inside it do not repeat it. */}
          <Text color={levelColor(group.level)} dimColor>
            {` ╭─ ${group.level.toUpperCase()} ${"─".repeat(Math.max(0, width - group.level.length - 7))}╮`}
          </Text>
          {shown.map((id) => (
            <Row key={id} id={id} indent="│" showLevel={false} edge="│" />
          ))}
          <Text color={levelColor(group.level)} dimColor>
            {` ╰${"─".repeat(Math.max(0, width - 4))}╯`}
          </Text>
        </>
      )}

      {group.kind === "path" &&
        shown.map((id, index) => <Row key={id} id={id} indent={" ".repeat(index) + (index > 0 ? GLYPH.step : "")} />)}

      {group.kind === "scattered" && shown.map((id) => <Row key={id} id={id} indent="" />)}

      {hidden > 0 && <Text dimColor>{`   … ${hidden} more`}</Text>}
    </Box>
  );
}

export function LayoutView(props: LayoutProps): ReactNode {
  if (props.layout.kind === "bands") return <Bands {...props} bands={props.layout.bands} />;
  if (props.layout.kind === "tree") return <Tree {...props} rows={props.layout.rows} />;
  return <PathLayout {...props} steps={props.layout.steps} />;
}
