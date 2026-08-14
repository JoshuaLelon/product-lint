import type { Diagnostic } from "./types.js";

/**
 * Every diagnostic must tell an agent what to do next. A code and a message
 * name the problem; the fix names the repair. Without a fix an agent guesses,
 * and a guess about product intent is the failure this tool exists to prevent.
 */
const FIXES: Record<string, string> = {
  // Frontier. Audience, Context, Product, and Behavior state user intent, so an
  // agent must ask the user. Architecture and Mechanism follow from the code, so
  // an agent may propose them and let the user correct the proposal.
  "PL0011 MISSING_AUDIENCE":
    "Search the repository for an existing answer first. Then put the question to the user in one of the formats below. Name each set that distinguishes your users, and every value in it. Create docs/audience/<set>-<value>.json from details.nodeTemplate, then run product-lint knowledge sync --staged.",
  "PL1106 MISSING_AUDIENCE_SET":
    "This wildcard names an audience set with no values. Either create docs/audience/<set>-<value>.json for each value of that set, or remove the wildcard from constrainedBy.",
  "PL2107 AUDIENCE_WIDENED":
    "Adding this parent widened the node's audience. If that is intended, keep it. If it is not, remove the parent that widened it — audience below Context is derived from ancestry, so a node reaches everyone its parents reach.",
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
  "PL0603 OVERLAPPING_MECHANISM":
    "Decide which Mechanism owns the shared files and narrow the other node's implementation.files so each governed file has exactly one owner. If neither node owns them alone because the two say the same thing, delete one and give the survivor both parents — a node is allowed many parents. Then run product-lint knowledge sync --staged.",
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
    'Set level to one of "audience", "context", "product", "behavior", "architecture", or "mechanism".',
  "PL1006 LEVEL_FOLDER_MISMATCH":
    "Move the file to docs/<level>/, or change the level field to match the folder.",
  "PL1007 ID_LEVEL_MISMATCH":
    "Make the id prefix equal the level. A node with level behavior needs an id that starts with behavior.",
  "PL1009 MISSING_STATEMENT":
    "Add a statement that says what is true at this level. Write one sentence.",
  "PL1010 MISSING_CONSTRAINTS":
    'Add "constrainedBy": []. An Audience node uses an empty array. Every other level lists its direct parents, and a Context may name an audience set with audience.<set>.*.',
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
    "Knowledge flows down only: Audience, Context, Product, Behavior, Architecture, Mechanism. Remove the upward entry from constrainedBy.",
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

  // Terms
  "PL1301 INVALID_TERM":
    'Replace the file contents with a single JSON object holding $schema, schemaVersion, id, level, name, definition, rejected, and optionally borrowed and sync. rejected is a list of {name, stance, because}, stance being wrong or taken; write "rejected": [] to say no other name was weighed.',
  "PL1302 INVALID_TERM_ID":
    'Rewrite the id as "term." followed by lowercase words joined by hyphens, for example "term.retain-plan".',
  "PL1303 DUPLICATE_TERM_ID":
    "Give one of the two term files a new id, or delete the duplicate file.",
  "PL1304 DUPLICATE_TERM_NAME":
    "Rename one term's name field — a two-word name is a good name: day plan, retain plan. Then rewrite every marked use of the renamed sense; run product-lint knowledge affected-by <term-id> to list the texts that mark it, and re-read each one to decide which sense it meant. Uses you rewrite are semantic changes and take Knowledge-Change trailers.",
  "PL1305 MISSING_TERM_DEFINITION":
    "Add a non-empty name and a one-sentence definition. Define the thing, not the promise: say what kind of thing it is and what tells it from its neighbours.",
  "PL1306 TERM_FOLDER_MISMATCH":
    "Move the file to docs/<level>/terms/, or change the level field to match the folder.",
  "PL1307 MISSING_TERM":
    "Create docs/<level>/terms/<slug>.json at the shallowest level whose statements need the word, then run product-lint knowledge sync --staged. If the word is ordinary English here, remove the marks instead.",
  "PL1308 TERM_FROM_BELOW":
    "Decide which is wrong. If the statement leaks a deeper word, rewrite it in this level's vocabulary — the promise, not the surface or model that keeps it. If the term is declared too deep, move its file up a level — but only if the definition survives that level's falsifier: a product term dies when you promise something else, not when a surface or the internal model changes.",
  "PL1310 TERM_CYCLE":
    "Break the cycle. Remove a marked term from one definition named in the message, and say the thing in plain words there instead.",
  "PL1311 MALFORMED_TERM_MARK":
    "Balance the asterisks so every mark reads *term-name*, with no space just inside the marks. Escape a literal asterisk as \\*.",

  // Synchronization
  "PL2001 STALE_CONSTRAINTS":
    "Run product-lint knowledge sync --staged, then stage the rewritten JSON with git add docs/.",
  "PL2002 STALE_IMPLEMENTATION":
    "Run product-lint knowledge sync --staged, then stage the rewritten JSON with git add docs/.",
  "PL2004 STALE_VOCABULARY":
    "Run product-lint knowledge sync --staged, then stage the rewritten JSON with git add docs/. Re-read the statement against the new definition, and edit the statement if the meaning moved.",
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

  // Deletions. The classification is a reading and never blocks; the record it
  // suggests is enforced against the diff by the commit-message codes below.
  "PL2108 NODE_REMOVED":
    'If the removal is intended, declare it: add "Knowledge-Removed: <node-id>" to the trailer block and say why in the body. If it is not, restore the node: git restore --staged --worktree --source=HEAD -- <path>.',
  "PL2109 NODE_RENAMED":
    'If this is one claim restated, declare one event: "Knowledge-Renamed: <old-id> -> <new-id>". If the old claim is genuinely withdrawn and the new node is unrelated, declare "Knowledge-Removed: <old-id>" instead. The pairing is a reading, not a fact — the trailer you write is the record.',
  "PL2110 COVERAGE_NARROWED":
    "The problem a parent states does not follow a child that moves away. Read what remains under this parent; if it still covers the problem, keep the move and say why in the body. If the move was incidental, restore the parent to the child's constrainedBy.",

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
  "PL2207 REMOVAL_DECLARED_AS_CHANGE":
    'A deletion is not an edit. Replace this line with "Knowledge-Removed: <node-id>" — or "Knowledge-Renamed: <node-id> -> <new-id>" when a staged addition restates the claim.',
  "PL2208 MISSING_REMOVAL_TRAILER":
    'Add one trailer line for this deletion: "Knowledge-Removed: <node-id>" if the claim is withdrawn, or "Knowledge-Renamed: <node-id> -> <new-id>" if a staged addition restates it. Removal lines sit in the same trailer block as Knowledge-Change, one event per line.',
  "PL2209 SPURIOUS_REMOVAL_TRAILER":
    "Delete this trailer line, or stage the deletion it declares. Only an id the staged diff deletes may be declared removed or renamed.",
  "PL2210 UNSTAGED_RENAME_TARGET":
    'Point the trailer at the staged node that restates the claim, or declare "Knowledge-Removed: <old-id>" if nothing does.',

  // Vocabulary report. Judgement calls: detected, put to a human, never enforced.
  "PL0801 UNMARKED_TERM_USE":
    "Three readings; choose one per statement. It is the defined term: mark it, *word*. It is ordinary English: leave it — this report is a review, not a gate. It is a second meaning: do not mark it — coin a different name and declare it, and consider rewording the sentence so the shared word stops carrying two senses.",
  "PL0802 SYNONYM_CANDIDATE":
    "If these are one thing, keep one name: delete one file and rewrite the loser's marked uses — product-lint knowledge affected-by <term-id> lists them. If they are two things, sharpen both definitions until each states what the other is not; a reader must be able to tell them apart from the definitions alone.",
  "PL0803 CAPITALIZED_UNDECLARED":
    "If this capital marks a product noun, declare it in docs/<level>/terms/ and mark the uses. If it is not a term, lowercase it — mid-sentence capitals are the convention this graph reserves for defined vocabulary.",
  "PL0804 UNUSED_TERM":
    "Mark the statements that use this word, or delete the declaration if nothing needs it.",
  "PL0805 TERM_UNUSED_AT_ITS_LEVEL":
    "No statement at the declaring level marks this term. Either mark one that uses it, or move the declaration down to the shallowest level whose statements do.",
  "PL0806 REJECTED_NAME_IN_PROSE":
    "If the sentence means the term, use the term's name and mark it. If it means a second thing, that thing needs a name of its own — a rejection standing in the way says you decided so once already. If the word is ordinary English here, leave it: this report is a review, not a gate.",
  "PL1312 REJECTED_TERM_NAME":
    "Give this term a two-word name saying which sense it carries — the repair PL1304 already prescribes for one word two levels want, and it produces the better name anyway. Delete the rejection instead only if you actually changed your mind; the deleted line is then the record of the reversal. If the word is spoken for rather than wrong, the rejection's stance is taken, not wrong, and nothing stands in your way.",
};

/**
 * Asks for the vocabulary codes whose repair is a judgement. The frontier codes
 * share ASK_FORMATS because their question is open; these carry the specific
 * choice instead, in the spirit of `contested`: name the pair, let a human decide.
 */
const ASKS: Record<string, string> = {
  "PL1304 DUPLICATE_TERM_NAME":
    "If the two declarations describe one thing rather than two, this is not a collision but a duplicate: delete one file and keep the better sentence.",
  "PL1308 TERM_FROM_BELOW":
    "Put it as candidates to choose: show the statement rewritten without the term beside the term redeclared shallower, with the consequence of each.",
  "PL0801 UNMARKED_TERM_USE":
    "If you cannot tell which reading is true, that is the finding. Show the user the sentence beside the definition and let them say what was meant.",
  "PL0802 SYNONYM_CANDIDATE":
    "This is a judgement, so put the pair and both definitions to the user and record only what they confirm.",
  "PL0806 REJECTED_NAME_IN_PROSE":
    "Show the user the sentence beside the rejection's reason and let them say which it is: the term meant, a second thing, or ordinary English.",
  "PL1312 REJECTED_TERM_NAME":
    "Nothing can tell a duplicate wearing the rejected name from a real second sense. Show the user the rejection's reason beside both definitions and record only what they confirm.",
  "PL2108 NODE_REMOVED":
    "A removal destroys a claim someone approved, so it is confirmed, never inferred. Show the owner the statement and what its parent keeps, and record only what they confirm: removed on purpose, or restored.",
  "PL2109 NODE_RENAMED":
    "If you cannot tell whether the new statement is the old claim restated, that is the finding. Show the user both statements side by side and let them say which it is.",
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
  "PL0011 MISSING_AUDIENCE",
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
 *
 * The one-thing rule lives here rather than beside the MECE rule because it is a
 * rule about a SENTENCE: it is applied while the statement is being written, and
 * it is checked by reading that statement alone.
 */
export const STATEMENT_STYLE =
  "Write in ASD-STE100 Simplified Technical English. Use the active voice. " +
  "Use one sentence of 25 words or fewer. Use simple words and no idiom. " +
  "Name who does the action. Do not use a noun as a verb. " +
  "State one thing. If the sentence joins two claims that can be false " +
  "independently, write two nodes instead.";

/**
 * How a node sits beside the nodes around it.
 *
 * Deliberately separate from STATEMENT_STYLE. That rule is about one sentence;
 * this one is about a SET, and it cannot be checked by reading a node alone —
 * two overlapping nodes each read correct in isolation, which is exactly why an
 * agent needs to be told before it writes the second one.
 *
 * Not mechanically enforced. Mutual exclusivity between two prose statements has
 * no deterministic test, and a guess that blocks a commit is worse than a rule
 * that instructs.
 */
export const NODE_SHAPE = [
  "Keep each level a set of small nodes that do not overlap and that cover the level.",
  "One node states one thing. Prefer more small nodes over fewer large ones.",
  "Before you add a node, read the nodes already at that level.",
  "If one of them already states this, do not write a second node. Add your parent to its constrainedBy list instead — a node is allowed many parents, and two sources that agree are one node with two parents.",
  "If one of them states part of this, split the smaller claim out and let both parents point at it.",
  "Name what the level does not cover yet. A gap you can name is work; a gap you cannot see is a wrong answer later.",
].join("\n");

/**
 * The shape rule for the audience level, which is shaped unlike every other.
 *
 * Every other level is one set of nodes. Audience is n sets, and the general
 * rule misleads at both ends: "keep the level a set that does not overlap"
 * reads as one flat list, and its repair — give the duplicate your parent —
 * cannot apply to nodes that have no parents. An agent given the general rule
 * here writes one node per combination, which is the shape this level exists
 * to avoid.
 */
export const AUDIENCE_SHAPE = [
  "The audience level is n sets, not one. Write audience.<set>.<value>.",
  "A set is one question about a person that has exactly one answer. Its values are the answers. Role and plan are two sets, because a person has one of each.",
  "Keep every set a partition: each person has exactly one value in it, and the values together cover everyone.",
  "Do not write one node per combination. A Context that names one value from each of two sets already means both, because sets are read as AND and values within a set as OR.",
  "Add a set only when some Context is true for one of its values and false for another. A set no Context distinguishes is a set that does the graph no work.",
  "Audience nodes have no parents. Name what no set distinguishes yet: a segment you can name is work, and one you cannot see is a wrong answer later.",
].join("\n");

/**
 * Which level a statement belongs at.
 *
 * The third rule, and the third scope. STATEMENT_STYLE is checked by reading one
 * SENTENCE. NODE_SHAPE is checked by reading the LEVEL. This one is checked by
 * reading a node beside its PARENT, and neither of the others can catch what it
 * catches: a node that is well written, that overlaps no sibling, and that sits
 * one level too deep reads correct all three times it is looked at.
 *
 * Placement is decided by what would FALSIFY the statement, never by what the
 * statement is about. Every level talks about the same product, so a subject
 * matter test leaks at every boundary; the falsifier does not, because each
 * level owns exactly one class of change. A sentence with two falsifiers is not
 * an ambiguous node, it is two nodes — the one-thing rule read down the graph
 * instead of across a sentence.
 *
 * Not mechanically enforced, for the reason NODE_SHAPE is not. PL1104 can see
 * that a parent exists one level up. Nothing can see that the statement belongs
 * there.
 */
export const LEVEL_PLACEMENT = [
  "A level is decided by what would make the statement false, not by what the statement is about.",
  "Name the smallest change that would force you to rewrite the sentence, then find that change below.",
  "audience: a kind of person appears, or two values become one.",
  "context: users stop having the problem. A context statement stays true even if you build nothing.",
  "product: you decide to promise something else. Name no surface here.",
  "behavior: someone uses the product and sees something else. Name the actor and the occasion.",
  "architecture: a responsibility moves across a boundary and the output does not change.",
  "mechanism: the code changes and the ownership model does not.",
  "Write the node at the shallowest level whose change would falsify it.",
  "Product has no occasion and Behavior has one. If you cannot say when to go and watch it, you are still at Product.",
  "The child must be able to be false while the parent stays true. If it cannot, do not write it — write the claim the parent does not already contain.",
].join("\n");

/**
 * The fourth rule and the fourth scope. STATEMENT_STYLE is checked by reading
 * one sentence, NODE_SHAPE by reading the level, LEVEL_PLACEMENT by reading a
 * node beside its parent. This one is checked by reading a sentence beside the
 * VOCABULARY — the declared terms in scope — which is why the terms travel
 * with the diagnostics that deliver it: a rule about a set the reader cannot
 * see is advice, not information.
 *
 * Partially enforced, unlike the other three, because uses are visible: a
 * marked word must resolve (PL1307), one name has one declaration (PL1304),
 * and vocabulary flows down only (PL1308). What stays instructed is meaning —
 * whether an unmarked word is the term, ordinary English, or a second sense —
 * and the report puts exactly that to a human rather than guessing.
 */
export const VOCABULARY_RULE = [
  "A marked word is a defined term: *plan* is the plan this graph defines, and plan is English.",
  "If a defined word appears in your sentence with its defined meaning, mark it: *word*.",
  "One thing has one name. Read the terms in scope before you coin a word; if one already names this thing, use it.",
  "One name has one thing. Do not use a marked word in a second sense — coin a different name. A two-word name is a good name.",
  "Declare a term at the shallowest level whose statements need it: docs/<level>/terms/<slug>.json. Every level may declare, so a name for something in the member's world belongs at context, not at product.",
  "Define the thing, not the promise. Say what kind of thing it is and what tells it from its neighbours; the laws about it stay in the nodes that state them.",
  "A statement may use terms of its own level and above, never below. If you need a deeper word, you are stating a deeper thing.",
  "Record the names you weighed and passed on, and why: rejected. A statement can be reconstructed from the problem and the code; a discarded word cannot be reconstructed from anything, and it exists only while you are choosing. Say wrong when the word does not name this thing, taken when it already names something else here. An empty list means nothing was weighed.",
  "If the word is borrowed from a field that owns it already, say so and say how our sense departs: borrowed. Naming the failure state of an established metric is not inventing terminology, as long as the node says so.",
].join("\n");

/** Diagnostics that ask a human or an agent to write prose. */
const STYLE_CODES = new Set([
  "PL0011 MISSING_AUDIENCE",
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

/**
 * Diagnostics that are about to make an agent ADD a node. The shape rule is
 * useless after the fact and decisive before, so it rides only these.
 *
 * LEVEL_PLACEMENT rides the same set, for the same reason and with the same
 * boundary: every code here names a level that has a level above it, which is
 * what the pair check needs. PL0011 is absent because an Audience node has no
 * parent, so "the child must be able to be false while the parent stays true"
 * would send an agent looking for something the level forbids — the defect
 * AUDIENCE_SHAPE exists to avoid. One set, not two identical ones, because two
 * copies of the same six codes drift.
 */
const SHAPE_CODES = new Set([
  "PL0001 MISSING_CONTEXT",
  "PL0101 MISSING_PRODUCT",
  "PL0201 MISSING_BEHAVIOR",
  "PL0301 MISSING_ARCHITECTURE",
  "PL0401 MISSING_MECHANISM",
  "PL1009 MISSING_STATEMENT",
]);

/**
 * Beyond the six SHAPE_CODES — where a new statement is about to use or coin
 * the next term — only PL1307 carries the full rule, because its repair is a
 * declaration and the rule says where declarations go. The report codes
 * (PL08xx) deliberately do not: a report prints many rows, their fix lines
 * already carry the decision, and the same eight lines repeated per row would
 * bury the findings under the rule.
 */
const VOCABULARY_CODES = new Set(["PL1307 MISSING_TERM"]);

export function annotateDiagnostic(diagnostic: Diagnostic): Diagnostic {
  const fix = diagnostic.fix ?? FIXES[diagnostic.code];
  const ask =
    diagnostic.ask ??
    (ASK_CODES.has(diagnostic.code) ? ASK_FORMATS : ASKS[diagnostic.code]);
  const style = diagnostic.style ?? (STYLE_CODES.has(diagnostic.code) ? STATEMENT_STYLE : undefined);
  // The audience level is n sets rather than one, so it takes its own rule.
  const shape =
    diagnostic.shape ??
    (diagnostic.code === "PL0011 MISSING_AUDIENCE"
      ? AUDIENCE_SHAPE
      : SHAPE_CODES.has(diagnostic.code)
        ? NODE_SHAPE
        : undefined);
  const placement =
    diagnostic.placement ?? (SHAPE_CODES.has(diagnostic.code) ? LEVEL_PLACEMENT : undefined);
  const vocabulary =
    diagnostic.vocabulary ??
    (SHAPE_CODES.has(diagnostic.code) || VOCABULARY_CODES.has(diagnostic.code)
      ? VOCABULARY_RULE
      : undefined);
  if (!fix && !ask && !style && !shape && !placement && !vocabulary) return diagnostic;
  return {
    ...diagnostic,
    ...(fix ? { fix } : {}),
    ...(ask ? { ask } : {}),
    ...(shape ? { shape } : {}),
    ...(style ? { style } : {}),
    ...(placement ? { placement } : {}),
    ...(vocabulary ? { vocabulary } : {}),
  };
}

export function annotateDiagnostics(diagnostics: Diagnostic[]): Diagnostic[] {
  return diagnostics.map(annotateDiagnostic);
}
