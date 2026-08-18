/**
 * What you can ask for, typed by the shape of what is selected.
 *
 * A selection is either a single node — nothing above it and nothing below — or
 * a path, a top-to-bottom line through the graph that passes through it. That
 * difference is not cosmetic: a claim on its own can only be judged against the
 * style rule, while a claim in a line can be judged against what constrains it
 * and what rests on it. So the shape decides both which actions are offered and,
 * for `critique`, what the prompt asks. One key, two questions, chosen by what
 * you are pointing at.
 *
 * Every prompt carries the repository's own STATEMENT_STYLE and NODE_SHAPE
 * rather than a restatement of them, so the editor cannot drift from what the
 * linter enforces.
 */
import { NODE_SHAPE, STATEMENT_STYLE } from "../src/remediation.js";
import { parseEdits, parseOptions } from "./claude.js";
import { nodesOf, type GraphView } from "./graph.js";
import type { SourceCanonicalNode } from "../src/types.js";

export interface Selection {
  view: GraphView;
  node: SourceCanonicalNode;
  /** Shallowest first, through the node. Length 1 means it stands alone. */
  path: string[];
}

export type Shape = "node" | "path";

export function shapeOf(selection: Selection): Shape {
  return selection.path.length >= 2 ? "path" : "node";
}

export interface Edit {
  id: string;
  from: string;
  to: string;
}

export type Proposal =
  | { kind: "options"; nodeId: string; options: string[] }
  | { kind: "edits"; edits: Edit[] };

export interface Action {
  id: string;
  key: string;
  label: string;
  /** One line in the menu, phrased as what happens when you pick it. */
  hint(selection: Selection): string;
  available(selection: Selection): boolean;
  prompt(selection: Selection): string;
  parse(raw: string, selection: Selection): Proposal;
}

function renderPath(selection: Selection): string {
  return nodesOf(selection.view, selection.path)
    .map((node) => `  ${node.level}  ${node.id}\n    ${node.statement}`)
    .join("\n");
}

function childrenOf(selection: Selection): string {
  return [...(selection.view.children.get(selection.node.id) ?? [])]
    .map((id) => `  - ${selection.view.byId.get(id)?.statement ?? id}`)
    .join("\n");
}

/**
 * Keep only edits that name a node on the path and actually change it.
 *
 * A model asked to restate five statements will often hand back one or two
 * unchanged, and showing those as pending edits would make the reviewer read
 * five diffs to find the two that are real.
 */
function toEdits(raw: string, selection: Selection): Proposal {
  const onPath = new Set(selection.path);
  const edits = parseEdits(raw)
    .filter((edit) => onPath.has(edit.id))
    .map((edit) => ({
      id: edit.id,
      from: selection.view.byId.get(edit.id)?.statement ?? "",
      to: edit.statement,
    }))
    .filter((edit) => edit.from !== "" && edit.from !== edit.to);
  if (edits.length === 0) throw new Error("Nothing on this path would change.");
  return { kind: "edits", edits };
}

const JSON_EDITS =
  `Reply with only this JSON and nothing else, no prose and no code fence:\n` +
  `{"edits":[{"id":"<node id>","statement":"<new statement>"}]}\n` +
  `Include only the nodes you would actually change.`;

const JSON_OPTIONS = `Reply with only a JSON array of three strings. No prose, no code fence.`;

export const ACTIONS: Action[] = [
  {
    id: "reword",
    key: "r",
    label: "reword",
    hint: () => "three ways to say this same claim",
    available: () => true,
    prompt: (selection) => {
      // The path now runs top to bottom through the node, so the part that
      // constrains it is the part before it, not the whole line.
      const at = selection.path.indexOf(selection.node.id);
      const above =
        at > 0 ? renderPath({ ...selection, path: selection.path.slice(0, at) }) : "";
      const below = childrenOf(selection);
      return [
        `You are rewording one statement in a product knowledge graph.`,
        ``,
        `Level: ${selection.node.level}`,
        `Current statement: ${selection.node.statement}`,
        ``,
        above ? `The path that constrains it, shallowest first:\n${above}` : `Nothing constrains it.`,
        below ? `These rest on it:\n${below}` : `Nothing rests on it.`,
        ``,
        `Style rule, which is not negotiable:`,
        STATEMENT_STYLE,
        ``,
        `Give three different rewordings. Each must keep the claim the same and`,
        `stay consistent with what constrains it and what rests on it.`,
        JSON_OPTIONS,
      ].join("\n");
    },
    parse: (raw, selection) => ({
      kind: "options",
      nodeId: selection.node.id,
      options: parseOptions(raw),
    }),
  },

  {
    // The selection-typed one. Alone, a statement can only be judged against the
    // style rule; in a path it can be judged against what constrains it, which
    // is a different question with a different answer shape.
    id: "critique",
    key: "c",
    label: "critique",
    hint: (selection) =>
      shapeOf(selection) === "path"
        ? "find where this path stops following, and fix it"
        : "find what is wrong with this claim, and fix it",
    available: () => true,
    prompt: (selection) => {
      if (shapeOf(selection) === "path") {
        return [
          `You are reviewing one path through a product knowledge graph.`,
          `Each statement is supposed to follow from the one above it: a level`,
          `answers the level above it and constrains the level below it.`,
          ``,
          `The path, shallowest first:`,
          renderPath(selection),
          ``,
          `Find the places where a statement does not follow from the one above`,
          `it, or restates it instead of advancing it, or promises something its`,
          `parent never asked for. Change as few statements as possible.`,
          ``,
          `Style rule, which is not negotiable:`,
          STATEMENT_STYLE,
          ``,
          `Shape rule:`,
          NODE_SHAPE,
          ``,
          JSON_EDITS,
        ].join("\n");
      }
      return [
        `You are reviewing one statement in a product knowledge graph.`,
        ``,
        `Level: ${selection.node.level}`,
        `Statement: ${selection.node.statement}`,
        ``,
        `Say nothing about what constrains it — nothing does. Judge it alone:`,
        `is it one claim, is it falsifiable, does it name who acts, is it at the`,
        `right level? Then give three corrected versions, best first.`,
        ``,
        `Style rule, which is not negotiable:`,
        STATEMENT_STYLE,
        ``,
        JSON_OPTIONS,
      ].join("\n");
    },
    parse: (raw, selection) =>
      shapeOf(selection) === "path"
        ? toEdits(raw, selection)
        : { kind: "options", nodeId: selection.node.id, options: parseOptions(raw) },
  },

  {
    // The one from the brief: change the wording at the top and carry it down.
    id: "percolate",
    key: "p",
    label: "percolate",
    hint: (selection) => `restate the top and bring the other ${selection.path.length - 1} into line`,
    available: (selection) => shapeOf(selection) === "path",
    prompt: (selection) =>
      [
        `You are restating one path through a product knowledge graph.`,
        ``,
        `The path, shallowest first:`,
        renderPath(selection),
        ``,
        `Restate the FIRST statement more precisely, then change every statement`,
        `below it that no longer sits well under the new wording. Keep every`,
        `claim the same claim: this is about how each one is worded, not about`,
        `what any of them promises.`,
        ``,
        `Style rule, which is not negotiable:`,
        STATEMENT_STYLE,
        ``,
        JSON_EDITS,
      ].join("\n"),
    parse: toEdits,
  },
];

export function actionsFor(selection: Selection): Action[] {
  return ACTIONS.filter((action) => action.available(selection));
}

export function actionByKey(selection: Selection, key: string): Action | undefined {
  return actionsFor(selection).find((action) => action.key === key);
}
