/**
 * The design system.
 *
 * Two rules, and `smoke.tsx` enforces both: no two meanings share a colour, and
 * no meaning has two colours. Every colour in this app is named here — a hex
 * literal anywhere else is a bug, because a colour invented at a call site is a
 * meaning nobody wrote down.
 *
 * Colour is not the only channel, and treating it as the only one is what makes
 * a terminal UI muddy. There are four here, and each carries exactly one kind of
 * information:
 *
 *   HUE        what kind of thing this is — its level, or its semantic role
 *   EMPHASIS   how much attention it wants — see WEIGHT below
 *   GLYPH      structural position — rails, cursors, diff polarity
 *   INDENT     containment — a definition sits under the word it defines
 *
 * A thing that needs to say two things says them on two channels. The row under
 * the cursor is bold (emphasis) AND carries the cursor glyph (structure) AND is
 * amber (role: selected) — three channels, three facts, no collision.
 */
import type { KnowledgeLevel } from "../src/types.js";

/**
 * Level: which stratum a thing belongs to.
 *
 * The only ordinal scale in the product, so the only ramp — cyan at the abstract
 * end, violet at the concrete end. Luminance stays in a narrow band across all
 * six, because a ramp that also darkened would put its bottom below readable on
 * a dark terminal, and this is a tool for reading sentences.
 *
 * The ramp occupies roughly 190°–290° of hue and nothing else may enter it, so a
 * level colour is never mistaken for a role colour.
 */
export const LEVEL: Record<KnowledgeLevel, string> = {
  audience: "#8BD5F0",
  context: "#79C3EA",
  product: "#7FB0E0",
  behavior: "#8D9CDB",
  architecture: "#9E8FD6",
  mechanism: "#B086CE",
};

/**
 * Roles: what a thing is, when what it is has nothing to do with level.
 *
 * Three, deliberately. Every additional hue is another thing the reader has to
 * hold, and the channels below carry far more than a fourth colour would.
 * All three sit outside the level ramp's arc.
 */
export const ROLE = {
  /**
   * What you have pointed at: the selected path, and the row under the cursor.
   *
   * Spent on this and nothing else. The whole point of selecting a path is that
   * it is unmistakable among sixty-seven statements, which only holds while no
   * second element competes for the same colour. Focus — which pane takes the
   * arrow keys — deliberately does NOT use it; that is an emphasis question, and
   * it is answered on the emphasis channel.
   */
  selected: "#F2B441",

  /**
   * Settled: the graph is valid and complete, or this is the wording an edit
   * would arrive at. Both are "the state you want to be in".
   */
  settled: "#6EE7B7",

  /**
   * Wrong: invalid, stale, a recorded mistake, a failed call.
   *
   * Not used for the losing side of a diff. Text a rewrite would replace is not
   * wrong, it is superseded, and superseded is an emphasis question — it goes
   * dim. Colouring it red would say two different things in one hue.
   */
  wrong: "#FB7185",
} as const;

/**
 * Emphasis: how much attention a thing wants. Carries no hue of its own.
 *
 *   bold    the focused pane, the row under the cursor
 *   normal  content — statements, and the definitions of declared terms
 *   dim     supporting matter — findings, labels, key hints, off-path rows,
 *           and the superseded side of a diff
 *
 * This is the channel that separates a definition from a finding in the
 * vocabulary pane. A definition is authored content and reads at full weight; a
 * finding is the tool talking about the content, and stays out of the way.
 */
export const WEIGHT = { bold: "bold", normal: "normal", dim: "dim" } as const;

/**
 * Every coloured surface in the app, and the role it plays.
 *
 * This table is the point of the system. The palette being injective only says
 * no colour has two meanings; it says nothing about the same meaning being
 * painted the same way on two different screens, which is the thing that
 * actually drifts as surfaces are added. Here every place that takes a colour
 * names its meaning, so two surfaces that mean the same thing are visibly the
 * same line of code rather than coincidentally the same hex.
 *
 * `app.tsx` reads colours from here and never from `ROLE` directly — enforced in
 * `smoke.tsx` — so a new screen cannot quietly invent a fourth meaning for
 * amber. Adding a surface means adding a row here, where the reviewer can see
 * whether the meaning already exists.
 *
 * Surfaces with no entry are deliberately uncoloured: they ride the emphasis
 * channel instead. A keycap is one — a key you may press is an affordance, not
 * a thing you have selected, and giving it the selection colour is how amber
 * quietly came to mean two things.
 */
export const SURFACE = {
  /** What you have pointed at. */
  "graph.rail.onPath": ROLE.selected,
  "graph.cursor": ROLE.selected,
  "graph.statement.onPath": ROLE.selected,
  "breadcrumb.rail": ROLE.selected,

  /** The state you want to be in. */
  "status.complete": ROLE.settled,
  "edit.becomes": ROLE.settled,

  /** Something is wrong. */
  "status.blocked": ROLE.wrong,
  "reference.kind.mistake": ROLE.wrong,
  "action.failed": ROLE.wrong,
} as const;

/** Structure: rails, cursor, and diff polarity. Position, never mood. */
export const GLYPH = {
  /** A row on the selected path. Heavy, so the path reads as a line. */
  railOn: "┃",
  /** A row off it, carrying its level's colour. */
  railOff: "│",
  cursor: "▸",
  /**
   * The card under the cursor, marked in the gutter beside it.
   *
   * A gutter rather than another colour or another weight: on a selected path
   * every card is already amber and already bold, so both of those channels are
   * spent and neither can say "and this one is where you are". A reserved column
   * is free, works the same in every view, and needs no background colour — which
   * would look wrong on half the terminals it landed in.
   */
  here: "▌",
  /**
   * The node the view is built from, when the cursor has moved off it.
   *
   * A lighter mark in the same gutter as the cursor, because the two answer the
   * same question at different scales: solid is where you ARE, dashed is where
   * the view is rooted. When they coincide the solid mark stands for both, which
   * is the truth rather than an omission.
   */
  anchor: "╎",
  /**
   * In the picked set.
   *
   * Its own reserved column, next to the cursor's, because being picked is
   * independent of everything already spoken for: a node can be picked and be
   * where the cursor is and be what the view is anchored on, all at once, and
   * one column cannot say three things. Every other channel was already taken —
   * amber means "what you have pointed at" and picking is not pointing, bold
   * means the focused pane, dim means off-path, and the card's heavy border
   * means focused. A second column is the only free channel left, and it costs
   * one character in every view rather than a fourth meaning in an existing one.
   *
   * Reserved whether or not anything is picked, so picking never reflows the
   * screen.
   */
  picked: "◆",

  /** Suggestions already fetched for the node under the cursor. */
  ready: "·",
  /** Diff polarity, so the two sides do not depend on colour alone. */
  was: "−",
  becomes: "+",
  /** Between steps of a path in the breadcrumb. */
  step: "›",
  /** A card's edge stubs: what constrains it above, what rests on it below. */
  stubUp: "╷",
  stubDown: "╵",
  /** A node already drawn higher up in a tree, reached again by another parent. */
  reentry: "↳",
} as const;
