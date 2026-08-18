/**
 * What to do with the nodes the reader has picked.
 *
 * The prompt is `NODE_SHAPE` — the repository's own rule for how a set of nodes
 * should sit beside each other. It is the one rule product-lint states and
 * cannot check: whether two prose statements overlap has no deterministic test,
 * and the rule says so. So it is written to be read by whoever is about to add a
 * node, and this is that reader, holding the set the rule is about.
 *
 * Because the prompt is the constant rather than a paraphrase of it, the
 * suggestions cannot drift from what the repository asks for.
 */
import { NODE_SHAPE, STATEMENT_STYLE } from "../src/remediation.js";
import { KNOWLEDGE_LEVELS } from "../src/types.js";
import { apiAvailable, askFor, runApi, unwrap } from "./claude.js";
import { answerSchema, suggestionSchema } from "./schema.js";
import { nodesOf, type GraphView } from "./graph.js";
import { sameChange, usable, type Change, type Suggestion } from "./changes.js";

/** The set, and the levels it spans, so the model can see what it is judging. */
function render(view: GraphView, ids: string[]): string {
  return nodesOf(view, ids)
    .map((node) => {
      // The node's own list, not the resolved parent edges. A Context names an
      // audience SET — `audience.role.*` — which is a legal parent and not a
      // node, so it has no edge in the parent map. Reading the map instead told
      // the model that every context node in this graph is constrained by
      // nothing, when each of them names the audience it is about.
      const parents = node.constrainedBy;
      const children = [...(view.children.get(node.id) ?? [])];
      return [
        `  ${node.id}  (${node.level})`,
        `    ${node.statement}`,
        `    constrainedBy: ${parents.length ? parents.join(", ") : "nothing"}`,
        `    rests on it:   ${children.length ? children.join(", ") : "nothing"}`,
      ].join("\n");
    })
    .join("\n");
}

/**
 * Every id the prompt names, and nothing else.
 *
 * The schema enumerates this rather than the whole graph, so the two cannot
 * disagree about what the model is allowed to refer to: `render` shows the
 * picked nodes with their parents and children, and `siblings` shows the rest
 * of their levels. A node outside that set is one the model was never shown, and
 * a reference to it could not have been reasoned about.
 */
export function visibleIds(view: GraphView, ids: string[]): string[] {
  const picked = nodesOf(view, ids);
  const levels = new Set(picked.map((node) => node.level));
  const seen = new Set<string>();
  for (const node of picked) {
    seen.add(node.id);
    // `constrainedBy` rather than the parent map, so an audience set a Context
    // names is offered too. Enumerating only node ids left the model unable to
    // express the one parent every context node in this graph actually has.
    for (const parent of node.constrainedBy) seen.add(parent);
    for (const child of view.children.get(node.id) ?? []) seen.add(child);
  }
  for (const node of view.byId.values()) if (levels.has(node.level)) seen.add(node.id);
  return [...seen];
}

export function promptFor(view: GraphView, ids: string[]): string {
  const levels = [...new Set(nodesOf(view, ids).map((node) => node.level))];
  const siblings = levels
    .map((level) => {
      const rest = [...view.byId.values()]
        .filter((node) => node.level === level && !ids.includes(node.id))
        .map((node) => `    ${node.id}: ${node.statement}`)
        .join("\n");
      return `  everything else at ${level}:\n${rest || "    nothing"}`;
    })
    .join("\n");

  return [
    `You are judging a set of claims in a product knowledge graph against the`,
    `rule below, and proposing what to do about it.`,
    ``,
    `The set the reader picked:`,
    render(view, ids),
    ``,
    siblings,
    ``,
    `The rule the set has to satisfy:`,
    NODE_SHAPE,
    ``,
    `Any statement you write must also satisfy:`,
    STATEMENT_STYLE,
    ``,
    `Levels, shallowest first: ${KNOWLEDGE_LEVELS.join(", ")}.`,
    ``,
    `Propose up to three separate suggestions, best first. Each is a small set of`,
    `operations that together do one thing worth doing — merging two nodes that`,
    `say the same thing, splitting a node that states two, giving a node another`,
    `parent instead of writing a duplicate, or adding the claim the level is`,
    `missing. Do not propose a suggestion that changes nothing.`,
    ``,
    // Every id above is already in this prompt, so the failure is not that the
    // model cannot see them: it derives one instead of copying it, suffixing
    // the node it is splitting or slugifying the statement it just wrote. That
    // is what `idFor` does for a genuinely new claim, and `added` is the only
    // operation that introduces one — so say where the line is.
    `Copy every "id" character for character from the ids above. Restating or`,
    `regoverning a claim never changes its id. Only "added" introduces a new`,
    `claim, and it carries no id: one is derived for it after you reply.`,
    ``,
    `Each suggestion carries a title and a summary. The title is one line — what`,
    `this does. The summary is two or three sentences of plain English for the`,
    `person deciding whether to accept it: what changes, and why it is worth`,
    `doing. The summary describes the graph rather than making a claim in it, so`,
    `it may say "because" and name a trade-off; the style rule above binds only`,
    `the statements you write.`,
    ``,
    // The reviewer reads this prose beside the claims themselves and never sees
    // an id anywhere in that pane. An id in the summary is a word they have to
    // decode against a list that is not on screen.
    `Never write an id in the title or the summary. Refer to a claim by what it`,
    `says — "the claim about deferrals" — because the reader sees the sentences,`,
    `not the ids.`,
    ``,
    `Reply with only this JSON, no prose and no code fence:`,
    `{"suggestions":[{"title":"<one line>","summary":"<two or three sentences>","changes":[`,
    `  {"kind":"restated","id":"<node id>","statement":"<new statement>"},`,
    `  {"kind":"regoverned","id":"<node id>","constrainedBy":["<node id>", ...]},`,
    `  {"kind":"added","level":"<level>","statement":"<statement>","constrainedBy":["<node id>", ...]},`,
    `  {"kind":"withdrawn","id":"<node id>"}`,
    `]}]}`,
  ].join("\n");
}

/**
 * The suggestion as the reader is looking at it.
 *
 * In the graph's own words for the operations, and in statements rather than
 * ids for the operands — the same rule the review pane follows. A follow-up
 * question is asked ABOUT what is on screen, so what the model is shown has to
 * be what is on screen; handing it a changeset full of ids would let it answer
 * about something the reader cannot see.
 */
function asShown(view: GraphView, suggestion: Suggestion): string {
  const lines = [`  title:   ${suggestion.title}`, `  summary: ${suggestion.summary}`];
  for (const change of suggestion.changes) {
    if (change.kind === "restated") {
      lines.push(`  restated  was: ${view.byId.get(change.id)?.statement ?? change.id}`);
      lines.push(`            now: ${change.statement}`);
    } else if (change.kind === "added") {
      lines.push(`  added to ${change.level}: ${change.statement}`);
    } else if (change.kind === "withdrawn") {
      lines.push(`  withdrawn: ${view.byId.get(change.id)?.statement ?? change.id}`);
    } else {
      lines.push(`  regoverned: ${view.byId.get(change.id)?.statement ?? change.id}`);
      lines.push(
        `            now rests on: ${change.constrainedBy
          .map((id) => view.byId.get(id)?.statement ?? id)
          .join(" | ")}`,
      );
    }
  }
  return lines.join("\n");
}

/**
 * A question about a suggestion, answered without changing it.
 *
 * Deliberately not the whole graph prompt: the reader is asking what a phrase in
 * front of them means, not asking for the set to be judged again. Handing over
 * the rules as well invites a revised proposal, which is the other mode.
 */
export function promptForAsk(view: GraphView, suggestion: Suggestion, question: string): string {
  return [
    `Someone is reviewing a proposed change to a product knowledge graph and has`,
    `asked a question about it. Answer the question. Do not propose anything new`,
    `and do not restate the proposal.`,
    ``,
    `The proposal they are looking at:`,
    asShown(view, suggestion),
    ``,
    `Their question:`,
    `  ${question}`,
    ``,
    `Answer in two to four sentences of plain English. Never write a node id —`,
    `refer to a claim by what it says. Reply with only this JSON, no prose and no`,
    `code fence:`,
    `{"answer":"<your answer>"}`,
  ].join("\n");
}

export function parseAnswer(raw: string): string {
  const text = unwrap(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The reply carried no JSON.");
  const answer = JSON.parse(text.slice(start, end + 1))?.answer;
  if (typeof answer !== "string" || answer.trim().length === 0) {
    throw new Error("The reply carried no answer.");
  }
  return answer.trim();
}

export async function askAbout(
  view: GraphView,
  suggestion: Suggestion,
  question: string,
): Promise<string> {
  const schema = answerSchema();
  return askFor(
    promptForAsk(view, suggestion, question),
    parseAnswer,
    3,
    apiAvailable() ? (prompt) => runApi(prompt, schema) : undefined,
  );
}

/**
 * A revised suggestion, made to an instruction.
 *
 * This one DOES carry the whole graph prompt, because a revision is a new
 * proposal and has to satisfy every rule the first one did — the shape rule, the
 * style rule, and the ids it is allowed to name. What is added is the proposal
 * being revised and what the reader wants kept.
 */
export function promptForAmend(
  view: GraphView,
  ids: string[],
  suggestion: Suggestion,
  instruction: string,
): string {
  return [
    promptFor(view, ids),
    ``,
    `A reviewer has read this proposal:`,
    asShown(view, suggestion),
    ``,
    `They want it revised:`,
    `  ${instruction}`,
    ``,
    `Reply with exactly one suggestion — the revised proposal, whole. Keep the`,
    `parts they did not ask you to change, and change what they did. Say in the`,
    `summary what you kept and what you moved.`,
  ].join("\n");
}

/**
 * A revision, or nothing when the instruction was already satisfied.
 *
 * Undefined rather than an error, and measured rather than guessed: an
 * instruction like "stop withdrawing anything" against a proposal that withdraws
 * nothing is already met, so the model rightly sends the same changeset back —
 * and `usable` rightly reads every one of those as a change that changes
 * nothing. Throwing made `askFor` ask twice more for a different answer to a
 * question that had been answered, then paint the reply red. Only an unreadable
 * reply is worth asking again, and `parseSuggestions` still throws on those.
 */
export async function amendWith(
  view: GraphView,
  ids: string[],
  suggestion: Suggestion,
  instruction: string,
): Promise<Suggestion | undefined> {
  const schema = suggestionSchema(view, visibleIds(view, ids));
  return askFor(
    promptForAmend(view, ids, suggestion, instruction),
    (raw) => parseSuggestions(view, raw)[0],
    3,
    apiAvailable() ? (prompt) => runApi(prompt, schema) : undefined,
  );
}

/** Whether a revision actually moved anything, both ways round. */
export function moved(before: Suggestion, after: Suggestion): boolean {
  const gained = after.changes.some((now) => !before.changes.some((was) => sameChange(was, now)));
  const lost = before.changes.some((was) => !after.changes.some((now) => sameChange(was, now)));
  return gained || lost;
}

/** The model's reply, kept only where it names things that exist. */
export function parseSuggestions(view: GraphView, raw: string): Suggestion[] {
  const text = unwrap(raw);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The reply carried no JSON.");
  const parsed = JSON.parse(text.slice(start, end + 1));
  const list = Array.isArray(parsed?.suggestions) ? parsed.suggestions : [];

  const suggestions: Suggestion[] = [];
  for (const item of list) {
    const title = typeof item?.title === "string" ? item.title.trim() : "";
    // The summary is what the reviewer reads, but a reply that omits it is still
    // a usable set of operations — falling back to the title beats discarding
    // the whole suggestion over its prose.
    const summary = typeof item?.summary === "string" ? item.summary.trim() : "";
    const changes = usable(view, Array.isArray(item?.changes) ? (item.changes as Change[]) : []);
    if (title && changes.length > 0) suggestions.push({ title, summary: summary || title, changes });
  }
  // An empty result is an ANSWER, not a failure to read one: the model looked at
  // the set and found nothing worth doing, which is a thing a good graph should
  // be able to hear. Throwing made `askFor` ask twice more for a different
  // answer to the same question and then paint the reply red. A reply that
  // carried no suggestions array at all is different, and still throws above.
  if (!Array.isArray(parsed?.suggestions)) {
    throw new Error("The reply carried no suggestions.");
  }
  return suggestions.slice(0, 3);
}

/**
 * One prompt, whichever transport answers it.
 *
 * The schema says the same thing the prompt's last paragraphs say, so the CLI
 * path is not left worse off by its absence — it is told the shape in prose and
 * checked afterwards, which is what it could always do. Where a key is present
 * the shape stops being advice: the ids in it are this graph's ids, so the
 * derived-id reply cannot be generated rather than being caught.
 *
 * The retry stays on both paths. A schema constrains what a reply says, not
 * whether it finishes saying it, and the reply that stops mid-object is the one
 * that costs everything.
 */
export async function suggestFor(view: GraphView, ids: string[]): Promise<Suggestion[]> {
  const schema = suggestionSchema(view, visibleIds(view, ids));
  return askFor(
    promptFor(view, ids),
    (raw) => parseSuggestions(view, raw),
    3,
    apiAvailable() ? (prompt) => runApi(prompt, schema) : undefined,
  );
}
