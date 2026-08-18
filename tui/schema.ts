/**
 * The reply's shape, built from the graph instead of described to the model.
 *
 * `promptFor` used to spell the reply out in prose and hope; `usable` then threw
 * away whatever came back wrong. Measured over sixteen runs, three replies named
 * an id the model had derived rather than copied — suffixing the node it was
 * splitting, or slugifying the statement it had just written. That is what
 * `idFor` does for a claim that is genuinely new, and it is right there in the
 * repository, so the model reaching for it is not a lapse. It was never told
 * where the line is.
 *
 * A schema states the line rather than asking for it. `id` is not "a node id",
 * it is an enumeration of the ids the prompt showed, so a derived one cannot be
 * emitted at all — the decoder has no token sequence for it. `level` is
 * `KNOWLEDGE_LEVELS` for the same reason. Both lists come from the graph as
 * read, so the constraint cannot fall out of step with it: there is no second
 * copy of the vocabulary to keep in sync.
 *
 * It does not make `usable` redundant, and measuring said so. Structured outputs
 * has no `minItems` and no `minLength`, so "a parent list that is not empty" is
 * not expressible; a run in twenty-four came back regoverning a Context to
 * nothing, which the schema permitted and the graph does not. `usable` is what
 * catches it — and it is what the other transport has instead of a schema.
 */
import { KNOWLEDGE_LEVELS } from "../src/types.js";
import { isAudienceWildcard } from "../src/audience.js";
import type { GraphView } from "./graph.js";

/**
 * Above this many ids the enumeration stops compiling.
 *
 * Measured against the API, bisecting on this graph's own ids: 32 compiled, 48
 * came back `invalid_request_error: Schema is too complex for compilation`. The
 * limit is the size of the token automaton, not the length of the list — a
 * hundred ids that shared a long prefix compiled fine, while forty-eight
 * unrelated ones did not. So this is a floor that held for ids shaped like the
 * ones this repository writes, not a documented constant, and a graph whose
 * naming changes should re-measure it.
 *
 * Past the limit `id` degrades to a plain string: the reply keeps its shape, and
 * `usable` goes back to being the thing that catches an id the graph does not
 * have. A weaker guarantee is worth more than a request that cannot be sent.
 */
export const MAX_ENUMERATED = 32;

/**
 * Structured outputs takes a subset of JSON Schema: `enum`, `const` and `anyOf`
 * are in, and every object must carry `required` and `additionalProperties:
 * false`. Nothing here needs the parts that are out — no recursion, no lengths,
 * no numeric bounds — because the shape being described is four flat records.
 */
function record(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: "object", additionalProperties: false, required, properties };
}

/**
 * `visible` is what the prompt put in front of the model, not the whole graph.
 *
 * Enumerating every id would let the schema bless a reference to a node the
 * model was never shown — a claim it cannot have had a reason to name. Scoping
 * the enumeration to the prompt's own contents makes the two agree by
 * construction, and has the side effect of staying under the compiler's ceiling
 * for any realistic pick.
 */
/**
 * An answer to a question about a suggestion.
 *
 * A schema for one string looks like overkill, and is not: the transport that
 * takes a schema refuses to run without one, and a reply that arrives as prose
 * with an apology in front of it is a reply the pane has to strip. Constraining
 * it to the field means the answer is the whole reply.
 */
export function answerSchema(): Record<string, unknown> {
  return record({ answer: { type: "string" } }, ["answer"]);
}

export function suggestionSchema(view: GraphView, visible: string[]): Record<string, unknown> {
  /**
   * Two enumerations, because the two positions accept different things. A
   * change acts ON a node, so `id` is nodes only. A `constrainedBy` entry names
   * a parent, and a Context's parent may be an audience SET rather than a node —
   * so the wildcard belongs there and only there. Using one list for both would
   * let a suggestion propose restating `audience.role.*`, which is not a file
   * and has no statement to restate.
   */
  const nodes = visible.filter((each) => view.byId.has(each));
  const parents = visible.filter((each) => view.byId.has(each) || isAudienceWildcard(each));
  const enumerate = (allowed: string[]) =>
    allowed.length > 0 && allowed.length <= MAX_ENUMERATED
      ? { type: "string", enum: allowed }
      : { type: "string" };

  const id = enumerate(nodes);
  const ids = { type: "array", items: enumerate(parents) };
  const statement = { type: "string" };

  const change = {
    anyOf: [
      record({ kind: { const: "restated" }, id, statement }, ["kind", "id", "statement"]),
      record({ kind: { const: "regoverned" }, id, constrainedBy: ids }, [
        "kind",
        "id",
        "constrainedBy",
      ]),
      record(
        {
          kind: { const: "added" },
          level: { type: "string", enum: [...KNOWLEDGE_LEVELS] },
          statement,
          constrainedBy: ids,
        },
        ["kind", "level", "statement", "constrainedBy"],
      ),
      record({ kind: { const: "withdrawn" }, id }, ["kind", "id"]),
    ],
  };

  return record(
    {
      suggestions: {
        type: "array",
        items: record(
          {
            title: { type: "string" },
            summary: { type: "string" },
            changes: { type: "array", items: change },
          },
          ["title", "summary", "changes"],
        ),
      },
    },
    ["suggestions"],
  );
}
