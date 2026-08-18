/**
 * The one place a model is spoken to.
 *
 * Kept here so the editor's rule holds visibly: product-lint itself makes no
 * model calls, and everything semantic happens up here in the shell.
 * `src/llms.ts` renders knowledge FOR a model; this runs one.
 *
 * Two transports, because they guarantee different things. The CLI borrows the
 * reader's existing Claude Code session, so it needs no key and no second bill;
 * the API can be handed a schema and refuse to generate a reply that breaks it.
 * The second is worth its key only where the reply has a shape the graph itself
 * defines, which is why it is offered rather than assumed.
 *
 * The SDK is a devDependency and this directory is not in `files`, so the
 * published package still installs nothing.
 */
import { spawn } from "node:child_process";
import Anthropic from "@anthropic-ai/sdk";
import { ROOT } from "./graph.js";

/**
 * Sonnet measured faster than Haiku here: the cost is harness startup, not
 * inference. Named in full rather than as the `sonnet` alias because the API
 * takes only full ids, and the CLI takes both — so one name serves both
 * transports and there is no second knob to keep in step with the first.
 */
export const MODEL = process.env.PL_TUI_MODEL ?? "claude-sonnet-5";

/**
 * Generous, because the failure it prevents is the expensive one. A reply that
 * stops mid-object loses everything, and was measured doing so once in sixteen
 * runs; a schema does not help, because a constrained decoder still stops when
 * it runs out of room. Suggestions are a few hundred tokens, so this is slack,
 * not a budget.
 */
const MAX_TOKENS = 16000;

/**
 * No tools at all.
 *
 * Every action here is a text transformation over context the editor has
 * already assembled and put in the prompt. Left with tools, the agent goes and
 * reads the repository to check what it was already told, which turned a
 * thirteen-second call into a three-and-a-half-minute one. `PL_TUI_TOOLS=default`
 * restores them for comparison.
 */
const TOOLS = process.env.PL_TUI_TOOLS ?? "";

/**
 * Low effort, because wall time here is almost exactly thinking tokens spent —
 * measured at roughly a hundred a second — and the thinking is unbounded by
 * default. The same percolate prompt was measured at 373 thinking tokens (7s)
 * and at 15302 (167s). Rewording a sentence under a fixed style rule does not
 * need deliberation on that scale, and an editor whose latency swings forty-fold
 * on identical input cannot be built on.
 */
const EFFORT = process.env.PL_TUI_EFFORT ?? "low";

export function runClaude(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // No MCP servers and no tools: these are text transformations, and booting
    // the full agent harness for them was most of the measured latency.
    const child = spawn(
      "claude",
      [
        "-p",
        prompt,
        "--output-format",
        "json",
        "--model",
        MODEL,
        "--tools",
        TOOLS,
        "--effort",
        EFFORT,
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
      ],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        /**
         * Without the key, deliberately.
         *
         * The CLI reads `ANTHROPIC_API_KEY` too, and prefers it over the login
         * it is supposed to be borrowing — so setting a key silently moved this
         * transport onto the API account and its separate bill, which is the
         * one thing this path exists not to do. It also made the fallback
         * useless: a refused key failed here for the same reason it failed
         * there, and the reader was left with no working transport at all.
         */
        env: Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name !== "ANTHROPIC_API_KEY"),
        ) as NodeJS.ProcessEnv,
      },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.stderr.on("data", (chunk) => (err += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `claude exited ${code}`));
      resolve(out);
    });
  });
}

/**
 * Ask again when the reply cannot be read, saying what was wrong with it.
 *
 * Measured over sixteen runs of the suggestion prompt: one reply stopped mid
 * object and carried no usable JSON at all, and three named an id the model had
 * derived rather than copied — suffixing the node it was splitting, or
 * slugifying the statement it had just written, which is exactly what `idFor`
 * does when a node is genuinely new. Both are a reply that does not answer, and
 * both are recoverable by asking again with the reason attached.
 *
 * The reason is the reader's own error, not a second description of the format:
 * the parse functions already say what they wanted, and repeating the shape
 * here would give the same rule two wordings that could drift apart.
 */
export async function askFor<T>(
  prompt: string,
  read: (raw: string) => T,
  tries = 3,
  // Taken as an argument so the retry can be checked without spawning anything:
  // the behaviour worth testing is what gets asked the second time, and that is
  // not observable from outside a function that owns its own transport.
  run: (prompt: string) => Promise<string> = runClaude,
): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const asked =
      attempt === 0
        ? prompt
        : `${prompt}\n\nYour previous reply could not be used: ${
            last instanceof Error ? last.message : String(last)
          }\nReply again, with only the JSON described above and nothing else.`;
    try {
      return read(await run(asked));
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/**
 * The second transport, for the calls whose reply has a shape worth enforcing.
 *
 * The CLI cannot constrain what comes back — it takes a prompt and returns
 * prose — so a reply that names something the graph does not have is only
 * findable afterwards, by throwing it away. The API can refuse to generate it
 * in the first place, which is a different guarantee and the only reason to
 * carry a second way of speaking to a model at all.
 *
 * It costs an API key, and the CLI path costs none, so this is offered rather
 * than assumed: `available` decides, and the caller falls back.
 */
/**
 * Set once the key in the environment has been refused.
 *
 * A key that is present but wrong was worse than no key at all: with no key the
 * editor uses the CLI and works, while a rejected key failed the call and left
 * the reader with a raw 401 where a suggestion should have been. A quoted value
 * in a dotenv file is enough to cause it. So the second transport is treated as
 * an upgrade that can be withdrawn, never as a commitment — the first refusal
 * turns it off for the session and everything falls back to the path that needs
 * no credentials.
 */
let keyRefused = false;

/**
 * The key as it was meant, not as the shell happened to hand it over.
 *
 * `KEY="sk-ant-…"` in a dotenv file survives `$(sed …)` with its quotes still
 * attached, and those quotes go out in the header and come back a 401. A quoted
 * or space-padded key is never a real key, so there is nothing to preserve by
 * refusing it — the value the reader plainly meant is recoverable, and taking
 * it is better than sending something we can already see is wrong.
 */
export function apiKey(): string | undefined {
  const raw = process.env.ANTHROPIC_API_KEY?.trim();
  if (!raw) return undefined;
  return raw.replace(/^['"]|['"]$/g, "").trim() || undefined;
}

export function apiAvailable(): boolean {
  return !keyRefused && Boolean(apiKey());
}

/** Why the key was refused, for the editor to say once rather than per call. */
export function apiNote(): string | undefined {
  if (!keyRefused) return undefined;
  return "ANTHROPIC_API_KEY was refused — using the Claude Code session instead";
}

let client: Anthropic | undefined;

export async function runApi(
  prompt: string,
  schema: Record<string, unknown>,
): Promise<string> {
  client ??= new Anthropic({ apiKey: apiKey() });
  let message: Awaited<ReturnType<typeof client.messages.create>>;
  try {
    message = await ask(client, prompt, schema);
  } catch (error) {
    // Only a credential problem falls back. A bad request or a rate limit is a
    // real answer about this call and must not be quietly retried somewhere
    // else, where it would look like it had worked.
    if (
      error instanceof Anthropic.AuthenticationError ||
      error instanceof Anthropic.PermissionDeniedError
    ) {
      keyRefused = true;
      return runClaude(prompt);
    }
    throw error;
  }
  return read(message);
}

function ask(client: Anthropic, prompt: string, schema: Record<string, unknown>) {
  return client.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    // The same argument as `EFFORT`, carried to its end. Sonnet 5 thinks by
    // default when the field is absent, and here that is most of the wall
    // clock: measured serially on this prompt, adaptive ran 9.5s at 731 output
    // tokens and disabled ran 6.5s at 352 — the same answer for two thirds of
    // the wait, and level with what the CLI path costs. There is nothing to
    // deliberate about: the shape is fixed by the schema and the judgement is
    // the one the prompt states.
    thinking: { type: "disabled" },
    output_config: { effort: EFFORT as never, format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: prompt }],
  });
}

/**
 * The reply's text, once the two stop reasons that leave it unusable are out.
 *
 * Both are answers rather than failures, so they are read before `content` and
 * raised as the reason `askFor` will quote when it asks again.
 */
function read(message: Anthropic.Message): string {
  if (message.stop_reason === "refusal") {
    throw new Error(`The model declined: ${message.stop_details?.category ?? "no reason given"}.`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new Error("The reply ran out of room before it finished.");
  }
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** The model's text arrives inside the CLI's result envelope, and may be fenced. */
export function unwrap(raw: string): string {
  const text = raw.trim();
  try {
    const envelope = JSON.parse(text);
    if (envelope && typeof envelope.result === "string") return envelope.result.trim();
  } catch {
    // Not an envelope; treat what came back as the text itself.
  }
  return text;
}

function slice(text: string, open: string, close: string): string {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start === -1 || end <= start) throw new Error("The reply carried no JSON.");
  return text.slice(start, end + 1);
}

export function parseOptions(raw: string): string[] {
  const parsed = JSON.parse(slice(unwrap(raw), "[", "]"));
  if (!Array.isArray(parsed)) throw new Error("The reply was not a list of statements.");
  const options = parsed.map(String).filter(Boolean).slice(0, 3);
  if (options.length === 0) throw new Error("The reply listed no statements.");
  return options;
}

export interface RawEdit {
  id: string;
  statement: string;
}

export function parseEdits(raw: string): RawEdit[] {
  const parsed = JSON.parse(slice(unwrap(raw), "{", "}"));
  const edits = Array.isArray(parsed?.edits) ? parsed.edits : [];
  const clean = edits
    .filter((edit: unknown): edit is RawEdit => {
      const record = edit as Record<string, unknown>;
      return typeof record?.id === "string" && typeof record?.statement === "string";
    })
    .map((edit: RawEdit) => ({ id: edit.id, statement: edit.statement.trim() }))
    .filter((edit: RawEdit) => edit.statement.length > 0);
  if (clean.length === 0) throw new Error("The reply proposed no edits.");
  return clean;
}
