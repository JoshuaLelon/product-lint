import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import {
  annotateDiagnostic,
  ASK_FORMATS,
  formatDiagnostic,
  STATEMENT_STYLE,
} from "../dist/index.js";

function declaredCodes() {
  const codes = new Set();
  for (const file of readdirSync("src").filter((name) => name.endsWith(".ts"))) {
    const text = readFileSync(`src/${file}`, "utf8");
    for (const match of text.matchAll(/code:\s*"(PL\d+ [A-Z_]+)"/g)) codes.add(match[1]);
  }
  // Emitted by the shared frontier template rather than a literal code field.
  for (const code of [
    "PL0101 MISSING_PRODUCT",
    "PL0201 MISSING_BEHAVIOR",
    "PL0301 MISSING_ARCHITECTURE",
    "PL0401 MISSING_MECHANISM",
  ]) {
    codes.add(code);
  }
  return [...codes];
}

test("every diagnostic code has a specific fix", () => {
  const missing = declaredCodes().filter(
    (code) => !annotateDiagnostic({ code, severity: "error", message: "" }).fix,
  );
  assert.deepEqual(missing, [], `codes without a fix: ${missing.join(", ")}`);
});

test("prose diagnostics carry the writing style, others do not", () => {
  const reason = annotateDiagnostic({
    code: "PL2204 MISSING_KNOWLEDGE_REASON",
    severity: "error",
    message: "",
  });
  assert.equal(reason.style, STATEMENT_STYLE);
  assert.match(reason.style, /Simplified Technical English/);

  const structural = annotateDiagnostic({
    code: "PL1105 KNOWLEDGE_CYCLE",
    severity: "error",
    message: "",
  });
  assert.equal(structural.style, undefined);
});

test("frontier diagnostics offer ask formats instead of an open question", () => {
  for (const code of [
    "PL0001 MISSING_CONTEXT",
    "PL0101 MISSING_PRODUCT",
    "PL0201 MISSING_BEHAVIOR",
    "PL0301 MISSING_ARCHITECTURE",
    "PL0401 MISSING_MECHANISM",
  ]) {
    const annotated = annotateDiagnostic({ code, severity: "info", message: "" });
    assert.equal(annotated.ask, ASK_FORMATS);
    assert.match(annotated.ask, /Draft to confirm/);
    assert.match(annotated.ask, /Candidates to choose/);
    assert.match(annotated.ask, /Decision brief/);
    // The old instruction put the whole burden on the user.
    assert.doesNotMatch(annotated.fix, /Do not invent the answer/);
  }

  const structural = annotateDiagnostic({
    code: "PL1105 KNOWLEDGE_CYCLE",
    severity: "error",
    message: "",
  });
  assert.equal(structural.ask, undefined);
});

test("the writing style stays self-contained", () => {
  assert.match(STATEMENT_STYLE, /Simplified Technical English/);
  assert.doesNotMatch(STATEMENT_STYLE, /skill/i);
});

test("an explicit fix is not overwritten by the table", () => {
  const annotated = annotateDiagnostic({
    code: "PL0701 DIRTY_SHIP_TREE",
    severity: "error",
    message: "",
    fix: "custom",
  });
  assert.equal(annotated.fix, "custom");
});

test("formatting renders the fix and wraps long guidance", () => {
  const text = formatDiagnostic({
    code: "PL2202 MISSING_KNOWLEDGE_TRAILER",
    severity: "error",
    message: "Semantic node change is missing Knowledge-Change: product.current-version",
  });
  assert.match(text, /\n {2}fix: Add a trailer line/);
  // The header stays on one line so it remains greppable. Guidance wraps.
  const guidance = text.split("\n").filter((line) => line.startsWith("  "));
  assert.ok(guidance.length > 1);
  for (const line of guidance) assert.ok(line.length <= 100, `long line: ${line}`);
});
