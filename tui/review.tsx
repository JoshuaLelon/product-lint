/**
 * Deciding whether to accept a suggestion.
 *
 * One pane, two columns, because the reviewer is doing two different things at
 * once and they want different kinds of attention. On the left is prose you
 * READ — what you picked, and what this suggestion does and why. On the right is
 * text you CHECK — the exact wording that would land in the files. Reading and
 * checking do not interleave, so they do not share a column.
 *
 * Nothing here names a node by its id.
 *
 * That is the whole design, and it comes from what a diff actually is: the slice
 * that differs, shown to someone who already holds the context. An id is not a
 * slice of anything. `− context.a-report-longer-than-the-reader-acts-on-is-…`
 * is a pointer rendered as if it were content, and it asks the reader to expand
 * an abstraction in their head before they can judge a single character of it.
 * Worse, half the operations have no textual difference at all: a `regoverned`
 * claim keeps its statement exactly, and what moves is which claims it answers
 * to. There is nothing to diff there, so this does not pretend to — it shows the
 * parent SENTENCES, before and after.
 *
 * A restatement needs no identifier either, and this is the load-bearing part:
 * the `−` line IS the claim as it stands today, so it names the node better than
 * any slug could. Every operation is therefore identified by the sentence it
 * acts on, and the pane speaks only the language the graph is written in.
 */
import { Box, Text } from "ink";
import { GLYPH, SURFACE } from "./theme.js";
import { audienceAxis, isAudienceWildcard } from "../src/audience.js";
import { sameChange, type Change, type Suggestion } from "./changes.js";
import type { GraphView } from "./graph.js";

/** Wrap to a column, so both halves keep a straight left edge. */
function lines(text: string, width: number): string[] {
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
 * What a parent IS, in words.
 *
 * A claim has a statement. An audience set does not — `audience.role.*` names
 * every value of a set, and it is a legal parent for a Context, so the one place
 * an id could still have leaked into this pane is here. It is said as what it
 * selects instead.
 */
function say(view: GraphView, id: string): string {
  const node = view.byId.get(id);
  if (node) return node.statement;
  if (isAudienceWildcard(id)) return `every ${audienceAxis(id) ?? "audience"}`;
  return id;
}

interface Side {
  mark: "was" | "becomes";
  text: string;
}

/**
 * One operation as sentences: what it is called, and what it does to the words.
 *
 * The kind keeps the graph's own vocabulary — restated, regoverned, added,
 * withdrawn — because those are the words `diff` and the commit trailers use,
 * and a fifth wording for the same four things is how a product ends up with two
 * names per idea. Only the operands change: they were ids and they are now the
 * claims themselves.
 */
export function sidesOf(view: GraphView, change: Change): { kind: string; about?: string; sides: Side[] } {
  if (change.kind === "restated") {
    return {
      kind: "restated",
      sides: [
        { mark: "was", text: say(view, change.id) },
        { mark: "becomes", text: change.statement },
      ],
    };
  }
  if (change.kind === "added") {
    // No "was": nothing is being replaced, so a `−` line would invent a claim
    // the graph never made. The level is worth saying because a new claim is the
    // one case where the reader cannot see where it lands.
    return {
      kind: `added to ${change.level}`,
      sides: [{ mark: "becomes", text: change.statement }],
    };
  }
  if (change.kind === "withdrawn") {
    return { kind: "withdrawn", sides: [{ mark: "was", text: say(view, change.id) }] };
  }
  // The statement does not move, so it goes above as the thing being spoken
  // about, and the sides carry the claims it answers to.
  // The node's own list, not the resolved parent edges: a Context names an
  // audience set, which carries no edge, so the map would report "nothing" for
  // every context claim in the graph.
  const before = [...(view.byId.get(change.id)?.constrainedBy ?? [])];
  return {
    kind: "regoverned",
    about: say(view, change.id),
    sides: [
      ...(before.length > 0
        ? before.map((id) => ({ mark: "was" as const, text: say(view, id) }))
        : [{ mark: "was" as const, text: "nothing" }]),
      ...change.constrainedBy.map((id) => ({ mark: "becomes" as const, text: say(view, id) })),
    ],
  };
}

/** Every row the right column would draw for one change, at this width. */
function changeRows(view: GraphView, change: Change, width: number): number {
  const { about, sides } = sidesOf(view, change);
  return (
    1 +
    (about ? lines(about, width - 2).length : 0) +
    sides.reduce((rows, side) => rows + lines(side.text, width - 2).length, 0)
  );
}

/**
 * Exactly how tall the pane will be.
 *
 * Read by the app's budget as well as by the drawing, because those two
 * disagreeing is what pushed the frame off the bottom of the terminal last time.
 */
export function reviewRows(
  view: GraphView,
  suggestion: Suggestion | undefined,
  width: number,
  cap: number,
  /** Prose shown instead of the summary, when a question has been answered. */
  answer?: string,
): number {
  if (!suggestion) return 3;
  const half = Math.max(20, Math.floor(width / 2) - 2);
  // Every line is drawn with a leading space, so the text wraps one column
  // narrower than the box — otherwise a full line loses its last character to
  // the indent in front of it.
  const column = half - 1;
  // Whichever prose the left column is actually showing.
  const body = answer ? lines(answer, column).length + 2 : lines(suggestion.summary, column).length;
  const left = 1 + 1 + lines(suggestion.title, column).length + 1 + body + 1 + 2;
  let right = 1;
  let shown = 0;
  for (const change of suggestion.changes) {
    const cost = changeRows(view, change, column);
    if (shown > 0 && right + cost > cap) break;
    right += cost;
    shown += 1;
  }
  if (shown < suggestion.changes.length) right += 1;
  return Math.min(cap, Math.max(left, right));
}

/**
 * The suggestion the reader is looking at, if there is one.
 *
 * Typing is a state INSIDE reviewing, not one beside it. Checking only for the
 * `suggestions` mode meant that pressing `/` — which moves the mode to
 * `talking` — unmounted the very pane the input had just been opened in, and
 * the input went with it. The guide went on saying "typing at a suggestion"
 * over an empty screen, which is what gave it away.
 */
export function underReview(
  modeName: string,
  suggestions: Suggestion[],
  at: number,
): Suggestion | undefined {
  if (modeName !== "suggestions" && modeName !== "talking") return undefined;
  if (suggestions.length === 0) return undefined;
  return suggestions[at % suggestions.length];
}

/** What the reader is in the middle of saying, if anything. */
export interface Talking {
  kind: "ask" | "amend";
  text: string;
}

/** A question already answered, kept beside the suggestion it was about. */
export interface Answered {
  question: string;
  answer: string;
}

export function ReviewPane({
  view,
  suggestion,
  at,
  total,
  width,
  cap,
  talking,
  answered,
  amendedFrom,
  waiting,
}: {
  view: GraphView;
  suggestion: Suggestion;
  at: number;
  total: number;
  width: number;
  cap: number;
  talking?: Talking;
  answered?: Answered;
  /** The proposal this one revised, so what moved can be marked. */
  amendedFrom?: Suggestion;
  waiting?: boolean;
}) {
  const half = Math.max(20, Math.floor(width / 2) - 2);
  const column = half - 1;

  const drawn: Change[] = [];
  let spent = 1;
  for (const change of suggestion.changes) {
    const cost = changeRows(view, change, column);
    if (drawn.length > 0 && spent + cost > cap) break;
    drawn.push(change);
    spent += cost;
  }
  const hidden = suggestion.changes.length - drawn.length;
  // What an amendment moved, worked out rather than asked for: the reader said
  // keep some and change the rest, so the answer only reads if the surviving
  // parts are visibly the surviving parts.
  const isNew = (change: Change) =>
    Boolean(amendedFrom) && !amendedFrom!.changes.some((before) => sameChange(before, change));
  const dropped = amendedFrom
    ? amendedFrom.changes.filter((before) => !suggestion.changes.some((now) => sameChange(before, now)))
        .length
    : 0;

  return (
    <Box flexDirection="row" gap={2}>
      <Box flexDirection="column" width={half} flexShrink={0}>
        {/* Only which suggestion. The panel directly above already names the
            picked set, and saying it twice in adjacent rows reads as two
            different facts until you notice they are one. */}
        <Text wrap="truncate">
          <Text bold>{`${GLYPH.railOn} SUGGESTION ${at + 1} OF ${total}`}</Text>
        </Text>
        <Text> </Text>
        {lines(suggestion.title, column).map((line, index) => (
          <Text key={`t${index}`} bold wrap="truncate">
            {` ${line}`}
          </Text>
        ))}
        <Text> </Text>
        {answered ? (
          <>
            {/* The answer stands where the summary was rather than under it.
                You asked because the summary did not settle it, so the answer is
                the thing to read — and the title above still says which
                proposal both are about. */}
            {lines(`you asked  ${answered.question}`, column).map((line, index) => (
              <Text key={`q${index}`} dimColor wrap="truncate">
                {` ${line}`}
              </Text>
            ))}
            <Text> </Text>
            {lines(answered.answer, column).map((line, index) => (
              <Text key={`a${index}`} wrap="truncate">
                {` ${line}`}
              </Text>
            ))}
          </>
        ) : (
          lines(suggestion.summary, column).map((line, index) => (
            <Text key={`s${index}`} wrap="truncate">
              {` ${line}`}
            </Text>
          ))
        )}
        <Text> </Text>
        {waiting ? (
          <Text dimColor wrap="truncate">{"  asking…"}</Text>
        ) : talking ? (
          <>
            {/* The mode rides in the prompt, so what the next keystroke means is
                never a thing you have to remember. */}
            <Text wrap="truncate">
              <Text bold color={SURFACE["graph.cursor"]}>{` ${talking.kind} ${GLYPH.step} `}</Text>
              <Text>{talking.text.slice(-Math.max(8, column - talking.kind.length - 4))}</Text>
              <Text color={SURFACE["graph.cursor"]}>{GLYPH.here}</Text>
            </Text>
            <Text dimColor wrap="truncate">
              {` tab ${talking.kind === "ask" ? "amend" : "ask"}   ⏎ send   esc cancel`}
            </Text>
          </>
        ) : (
          <Text dimColor wrap="truncate">
            {" ↑↓ suggestion   / ask or amend   y accept   esc back"}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" width={half} flexShrink={0}>
        <Text wrap="truncate">
          <Text dimColor bold>{`${GLYPH.railOff} WHAT CHANGES`}</Text>
          {amendedFrom && <Text dimColor>{`   ${dropped} dropped`}</Text>}
        </Text>
        {drawn.map((change, index) => {
          const { kind, about, sides } = sidesOf(view, change);
          return (
            <Box key={index} flexDirection="column">
              {/* The kind rides emphasis, not hue. A withdrawal used to be
                  painted in the colour that means "wrong", which it is not — a
                  duplicate claim being retired is the graph getting better. The
                  −/+ glyphs already carry the polarity. */}
              <Text wrap="truncate">
                <Text dimColor bold>{` ${kind}`}</Text>
                {isNew(change) && <Text bold color={SURFACE["edit.becomes"]}>{"   amended"}</Text>}
              </Text>
              {about &&
                lines(about, column - 2).map((line, row) => (
                  <Text key={`a${row}`} dimColor wrap="truncate">
                    {`   ${line}`}
                  </Text>
                ))}
              {sides.flatMap((side, sideIndex) =>
                lines(side.text, column - 2).map((line, row) => (
                  <Text key={`${sideIndex}-${row}`} wrap="truncate">
                    <Text
                      color={side.mark === "becomes" ? SURFACE["edit.becomes"] : undefined}
                      dimColor={side.mark === "was"}
                    >
                      {row === 0 ? ` ${side.mark === "was" ? GLYPH.was : GLYPH.becomes} ` : "   "}
                    </Text>
                    <Text
                      color={side.mark === "becomes" ? SURFACE["edit.becomes"] : undefined}
                      dimColor={side.mark === "was"}
                    >
                      {line}
                    </Text>
                  </Text>
                )),
              )}
            </Box>
          );
        })}
        {hidden > 0 && <Text dimColor>{`   … ${hidden} more`}</Text>}
      </Box>
    </Box>
  );
}
