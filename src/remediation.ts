import type { Diagnostic } from "./types.js";

/**
 * Every diagnostic must tell an agent what to do next. A code and a message
 * name the problem; the fix names the repair. Without a fix an agent guesses,
 * and a guess about product intent is the failure this tool exists to prevent.
 */
const FIXES: Record<string, string> = {
  // Frontier. Context, Product, and Behavior state user intent, so an agent must
  // ask the user. Architecture and Mechanism follow from the code, so an agent may
  // propose them and let the user correct the proposal.
  "PL0001 MISSING_CONTEXT":
    "Search the repository for an existing answer first. Then put the question to the user in one of the formats below. Create docs/context/<name>.json from details.nodeTemplate, then run product-lint knowledge sync --staged.",
  "PL0101 MISSING_PRODUCT":
    "Search the repository for an existing answer first. Then put the question to the user in one of the formats below. Create docs/product/<name>.json from details.nodeTemplate with this node in constrainedBy, then run product-lint knowledge sync --staged.",
  "PL0201 MISSING_BEHAVIOR":
    "Search the repository for an existing answer first. Then put the question to the user in one of the formats below. Create docs/behavior/<name>.json from details.nodeTemplate with this node in constrainedBy, then run product-lint knowledge sync --staged.",
  "PL0301 MISSING_ARCHITECTURE":
    "Read the code and draft the answer yourself. Put the draft to the user in one of the formats below. Create docs/architecture/<name>.json from details.nodeTemplate with this node in constrainedBy, then run product-lint knowledge sync --staged.",
  "PL0401 MISSING_MECHANISM":
    "Read the code and draft the answer yourself. Put the draft to the user in one of the formats below. Create docs/mechanism/<name>.json from details.nodeTemplate with this node in constrainedBy, then run product-lint knowledge sync --staged.",
  "PL0501 MISSING_IMPLEMENTATION":
    "Add the repository paths this mechanism owns to implementation.files, then run product-lint knowledge sync --staged. A glob is allowed. Each path must exist.",
  "PL0502 DEAD_IMPLEMENTATION_PATH":
    "Remove the entry from implementation.files, or correct it to the path the file has now. Then run product-lint knowledge sync --staged.",
  "PL0601 UNMAPPED_FILE":
    "Add this path to implementation.files on the Mechanism node that owns it, or create a new Mechanism node for it. Then run product-lint knowledge sync --staged.",
  "PL0602 UNGOVERNED_TREE":
    "Do not create a Mechanism node yet. A Mechanism node needs an Architecture parent, and that level does not exist, so this repository must build the missing levels downward first. Start at the level named in requiredLevel and put the question below to the user. The tree below is every governed file with no owner, which is the size of the job inside the current governedPaths.include. If this repository had code before it had Product Lint, narrow that glob to the area you are modelling now, and widen it as each Mechanism node lands.",

  // Shipping
  "PL0701 DIRTY_SHIP_TREE":
    "Commit or stash every change, then run product-lint ship again.",

  // Canonical node shape
  "PL1000 INVALID_JSON": "Repair the JSON syntax in this file.",
  "PL1001 INVALID_NODE": "Replace the file contents with a single JSON object.",
  "PL1002 UNKNOWN_NODE_FIELD":
    "Delete the unknown field. A canonical node accepts only $schema, schemaVersion, id, level, statement, constrainedBy, sync, and implementation.",
  "PL1003 MISSING_NODE_ID":
    'Add an id of the form "<level>.<semantic-name>", for example "product.current-version".',
  "PL1004 INVALID_NODE_ID":
    "Rewrite the id as the level, a dot, then lowercase words joined by hyphens. Use letters, digits, dots, hyphens, and underscores only.",
  "PL1005 INVALID_LEVEL":
    'Set level to one of "context", "product", "behavior", "architecture", or "mechanism".',
  "PL1006 LEVEL_FOLDER_MISMATCH":
    "Move the file to docs/<level>/, or change the level field to match the folder.",
  "PL1007 ID_LEVEL_MISMATCH":
    "Make the id prefix equal the level. A node with level behavior needs an id that starts with behavior.",
  "PL1009 MISSING_STATEMENT":
    "Add a statement that says what is true at this level. Write one sentence.",
  "PL1010 MISSING_CONSTRAINTS":
    'Add "constrainedBy": []. A Context node uses an empty array. Every other level lists its direct parents.',
  "PL1011 INVALID_CONSTRAINT":
    "Make every constrainedBy entry a node id string. Remove objects, numbers, and null.",
  "PL1012 INVALID_SYNC":
    'Set "sync": { "constraintsDigest": "pending" }, then run product-lint knowledge sync --staged to fill it.',
  "PL1013 INVALID_IMPLEMENTATION":
    'Set "implementation": { "files": ["<path-or-glob>"], "digest": "pending" }, then run product-lint knowledge sync --staged.',
  "PL1014 IMPLEMENTATION_ON_NON_MECHANISM":
    "Delete the implementation field. Only a Mechanism node binds knowledge to files. Move the binding to a Mechanism node that this node constrains.",

  // Graph structure
  "PL1101 DUPLICATE_NODE_ID":
    "Give one of the two nodes a new id, or delete the duplicate file.",
  "PL1102 MISSING_CONSTRAINT_NODE":
    "Create the missing parent node, or correct the id in constrainedBy. Check for a typo first.",
  "PL1103 ILLEGAL_DEPENDENCY_DIRECTION":
    "Knowledge flows down only: Context, Product, Behavior, Architecture, Mechanism. Remove the upward entry from constrainedBy.",
  "PL1104 SKIPPED_KNOWLEDGE_LEVEL":
    "Add a parent from the level directly above this one. A level cannot be skipped. Create that parent node first if it does not exist.",
  "PL1105 KNOWLEDGE_CYCLE":
    "Break the cycle. Remove one constrainedBy entry from a node named in the message.",

  // References
  "PL1200 INVALID_REFERENCE_JSON": "Repair the JSON syntax in this reference file.",
  "PL1201 INVALID_REFERENCE": "Replace the file contents with a single JSON object.",
  "PL1202 INVALID_REFERENCE_ID":
    'Rewrite the id to start with "reference.", for example "reference.mistake-shared-cache".',
  "PL1203 DUPLICATE_REFERENCE_ID":
    "Give one of the two references a new id, or delete the duplicate file.",
  "PL1204 INCOMPLETE_REFERENCE":
    'Add a non-empty kind and statement. The kind classifies the memory, for example "mistake" or "decision".',
  "PL1205 MISSING_RELATED_NODE":
    "Create the named canonical node, or correct the id in relatedNodes.",
  "PL1206 INVALID_REFERENCE_EVIDENCE":
    'Give evidence both fields: { "commit": "<full-sha>", "files": [{ "path": "<repository-path>" }] }. Delete evidence if you cannot cite a commit.',
  "PL1207 INVALID_REFERENCE_FILE":
    'Give every evidence file a string path. Write optional lines as two numbers, for example "lines": [84, 126].',
  "PL1208 MISSING_REFERENCE_COMMIT":
    "Cite a commit that exists in this repository. Use the full 40-character SHA. Run git log to find it.",
  "PL1209 MISSING_REFERENCE_PATH":
    "Cite a path that exists in that commit. Run git show --stat <commit> to list its files.",

  // Synchronization
  "PL2001 STALE_CONSTRAINTS":
    "Run product-lint knowledge sync --staged, then stage the rewritten JSON with git add docs/.",
  "PL2002 STALE_IMPLEMENTATION":
    "Run product-lint knowledge sync --staged, then stage the rewritten JSON with git add docs/.",
  "PL2003 UNSAFE_SYNC_OVERWRITE":
    "Sync writes from the index and would discard your unstaged edits to this node. Stage the file with git add, or revert it, then sync again.",

  // Staged commit consistency
  "PL2101 UNMAPPED_STAGED_FILE":
    "Create a Mechanism node in docs/mechanism/ whose implementation.files matches this path, or add the path to an existing Mechanism node. Then run product-lint knowledge sync --staged.",
  "PL2102 STALE_STAGED_MECHANISM":
    "Run product-lint knowledge sync --staged, then stage the owner node with git add docs/.",
  "PL2103 STALE_DEPENDENT":
    "A parent changed, so every descendant must be restated or resynchronized. Run product-lint knowledge sync --staged, then git add docs/. Edit the descendant statement if the meaning changed.",
  "PL2104 SPURIOUS_SYNC":
    "This node holds a new digest but no input changed. Restore it with git checkout HEAD -- <path>, then stage the real cause.",
  "PL2105 FORMAT_ONLY_NODE_CHANGE":
    "Only whitespace or key order changed. Run product-lint knowledge sync --staged to rewrite the file in canonical form, or restore it with git checkout HEAD -- <path>.",
  "PL2106 UNGOVERNED_IMPLEMENTATION":
    "Do not create a Mechanism node yet. A Mechanism node needs an Architecture parent, and that level does not exist, so this repository must build the missing levels downward first. Start at the level named in requiredLevel and put the question below to the user. If this repository had code before it had Product Lint, narrow governedPaths.include in product-lint.config.json to the area you are modelling now, and widen it as each Mechanism node lands. See details.files for what is currently ungoverned.",

  // Commit message
  "PL2201 DUPLICATE_KNOWLEDGE_TRAILER":
    "Delete the repeated trailer line. Declare each node id exactly one time.",
  "PL2202 MISSING_KNOWLEDGE_TRAILER":
    "Add a trailer line for this node at the end of the commit message, in the form Knowledge-Change: <node-id>. Put one id per line, and leave a blank line before the first trailer.",
  "PL2203 SPURIOUS_KNOWLEDGE_TRAILER":
    "Delete this trailer line. Only a node whose meaning changed gets a trailer. A digest-only change gets none.",
  "PL2204 MISSING_KNOWLEDGE_REASON":
    "Add a body paragraph between the subject and the trailers. Say why the knowledge changed, not what changed. Leave a blank line on each side of the body.",
  "PL2205 SUBJECT_PATTERN_MISMATCH":
    "Rewrite the subject line to match commit.subjectPattern in product-lint.config.json. Only the subject is checked; the body and trailers are unaffected.",
  "PL2206 INVALID_SUBJECT_PATTERN":
    "Correct commit.subjectPattern in product-lint.config.json, or delete the field to leave the subject unconstrained.",
};

/**
 * An open question is expensive to answer, and the user has often answered it
 * already somewhere in the repository. Each format below costs the user a
 * confirmation or a choice instead of an essay. The agent does the work; the
 * user keeps the decision.
 */
export const ASK_FORMATS = [
  "Do the work before you ask. Read the README, docs/, the existing nodes, and the commit history first.",
  "Then choose the lightest format that fits what you found.",
  "1. Draft to confirm. Use this when the repository already answers the question. Write the statement, cite the file or commit you took it from, and ask the user to confirm or correct it.",
  "2. Candidates to choose. Use this when two or three readings are plausible. Write each candidate as one statement, give the consequence of each, and ask the user to pick one.",
  "3. Decision brief. Use this when the choice is open and the options lead to different products. Give the decision, the options, the implications of each option, your recommendation, and the reason for it. Cite a precedent if one exists.",
  "Never ask an open question with no draft attached. Never record an answer the user did not confirm.",
].join("\n");

/** Diagnostics that need an answer from the user. */
const ASK_CODES = new Set([
  "PL0001 MISSING_CONTEXT",
  "PL0101 MISSING_PRODUCT",
  "PL0201 MISSING_BEHAVIOR",
  "PL0301 MISSING_ARCHITECTURE",
  "PL0401 MISSING_MECHANISM",
  // Carry a frontier question of their own, so they need the same ask formats.
  "PL2106 UNGOVERNED_IMPLEMENTATION",
  "PL0602 UNGOVERNED_TREE",
]);

/**
 * Written in the style it asks for, so the example is the instruction.
 */
export const STATEMENT_STYLE =
  "Write in ASD-STE100 Simplified Technical English. Use the active voice. " +
  "Use one sentence of 25 words or fewer. Use simple words and no idiom. " +
  "Name who does the action. Do not use a noun as a verb.";

/** Diagnostics that ask a human or an agent to write prose. */
const STYLE_CODES = new Set([
  "PL0001 MISSING_CONTEXT",
  "PL0101 MISSING_PRODUCT",
  "PL0201 MISSING_BEHAVIOR",
  "PL0301 MISSING_ARCHITECTURE",
  "PL0401 MISSING_MECHANISM",
  "PL1009 MISSING_STATEMENT",
  "PL1204 INCOMPLETE_REFERENCE",
  "PL2204 MISSING_KNOWLEDGE_REASON",
  "PL2106 UNGOVERNED_IMPLEMENTATION",
  "PL0602 UNGOVERNED_TREE",
]);

export function annotateDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const fix = diagnostic.fix ?? FIXES[diagnostic.code];
  const ask = diagnostic.ask ?? (ASK_CODES.has(diagnostic.code) ? ASK_FORMATS : undefined);
  const style = diagnostic.style ?? (STYLE_CODES.has(diagnostic.code) ? STATEMENT_STYLE : undefined);
  if (!fix && !ask && !style) return diagnostic;
  return {
    ...diagnostic,
    ...(fix ? { fix } : {}),
    ...(ask ? { ask } : {}),
    ...(style ? { style } : {}),
  };
}

export function annotateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map(annotateDiagnostic);
}
