# Changelog

## 0.21.0

**`PL1210 UNREACHABLE_REFERENCE` refuses a reference no surface can reach.**

Everywhere else, storage that cannot be read is already refused: `PL0804` for a term nothing
marks, `PL0805` for one no statement at its level marks, `PL1401` for a scope root naming no
node, `PL1402` for an ignore naming a smell that does not exist. References were the one node
type exempt. `relatedNodes` is optional, `PL1204` asks only for a kind and a statement, and a
file with neither passed every check.

Both readers match on `relatedNodes`. `knowledge for-file` and `affected-by` intersect it
with the node set, and `standingMistakeDiagnostics` filters to references that carry it. So a
reference without it is not a weak record — it is a file that validates, syncs, commits, and
is returned by nothing for the rest of the repository's life. A `kind: "mistake"` with no
`evidence.commit` is the same failure by another route: `PL0920` reports a mistake only while
its node has not changed *since* the commit that recorded it, and with no commit there is
nothing to measure since.

An error rather than a warning, on `PL1401`'s standard: the failure is silent and total, and
a warning saying "nothing will ever read this file" is read by the same person who was not
going to read the file.

Found by proposing to write eight of them. Backfilling this repository's recorded mistakes
out of its own commit messages would have produced files that validated and were never read
again — and the tool would have said nothing, which is what made the proposal look cheap.

## 0.20.0

Found by dogfooding: Product Lint adopted into Product Lint.

**A draft declares nothing.** Writing, moving, and deleting a `draft: true` node take no
`Knowledge-Change` trailer, and deleting one takes no `Knowledge-Removed`.

A draft's statement is the sentence `adopt` generated; it says TODO. Demanding a declaration
for creating one asks an author to declare a decision they have explicitly not made, and
demanding one for deleting it asks them to withdraw a claim nobody made. The adoption commit
for this repository demanded 19 trailers, 8 of them for placeholders — more declarations for
scaffolding than for the claims beside them, on the one commit that is supposed to prove
adoption is cheap. It now demands 10, and every one names a real claim.

Promotion stays semantic, because that is the moment a claim gets made, and so does
demotion, which withdraws one. That is why the rule reads both sides of a change rather than
only the staged one: a change is exempt when the node is a draft on every side it exists on.

`draft` was already outside `semanticFingerprint`, so this adds no new judgement about what
a claim is. It extends the same one to the three cases a fingerprint cannot see, where the
node exists on only one side. The guard against smuggling a real claim in under the flag is
the one that already exists: `PL0902 DRAFT_LOOKS_WRITTEN`.

Only the declaration is waived. A draft still lands in the change set, so its file must
still be staged and `PL2102` still fires. Two things fall out. A draft is no longer offered
to the rename matcher, so promoting one placeholder into nine problems reads as nine claims
added rather than one restated plus eight new. And `diff` stops counting scaffolding as
product change, because it reads the same classification.

- **`adopt` names a governed root with no directories under it.** Such a root collapses to
  one cluster, which is the degenerate case the clustering exists to avoid — a graph with
  one problem in it says nothing to revise. The clustering is still right: inventing
  boundaries a flat tree does not declare would be `adopt` guessing at product structure,
  and per-file spines cost six nodes each. So it says so instead. A root with real modules
  beside loose files is not flat, and is not named.
- **`init` resolves the config's `$schema` instead of assuming an install.** An installed
  copy under `node_modules/product-lint` wins, then the running package if it sits inside
  the repository — what a vendored copy, or Product Lint hosting itself, needs — then the
  installed path for a global or `npx` run, because a relative path climbing out of the
  repository would be worse than one the next install makes true. A `$schema` pointing at
  nothing is the same failure as shipping no schema at all: every editor honouring it
  reports the file as unvalidatable.

## 0.19.0

Four gaps in the lifecycle, found by mapping it end to end rather than by hitting them.

**The walk-up had no work order, which broke the loop `adopt` exists to start.** After
`adopt`, every level is populated by placeholders, so `detectFrontier` saw every node as
covered and emitted no obligations — `frontier` fell back to printing a list of fifteen ids
and six questions, with no template, no siblings to read before writing a duplicate, and no
terms in scope. That is the one command whose job is "hand me the next thing to write with
everything I need", degrading at the one moment its reader knows least.

- **A draft node IS a frontier obligation.** A missing node owes existence; a draft owes a
  statement; both are answered by reading the level, reading the terms, and answering the
  level's question. So `PL0901` is now one diagnostic per node carrying the same work order,
  and `orderedObligations` picks them up for free.
- It also carries the ask formats, statement style, shape rule, and vocabulary rule, because
  a draft owes exactly what a missing node owes.
- The summary's per-level draft expansion is **deleted**, not rewritten: with one diagnostic
  per node the ordinary (severity, level, code) grouping produces the same rows. A special
  case that stops being needed is a special case that should stop existing.

**`PL0920 STANDING_MISTAKE` makes the record of a wrong claim resurface.** `kind: "mistake"`
references carry `relatedNodes` and a verified `evidence.commit`, and were read by
`knowledge for-file` and `affected-by` and by nothing else — so the most expensive knowledge
in a repository, the kind you only get by being wrong, was the least likely to be seen again.
Reported only while the node has not changed since the recording commit: a claim someone
revised has been answered, and repeating it would train a reader to skip the report.

**`product-lint diff [<ref>]` says what a change did to the product.** `git diff` answers a
different question — a rename plus a rewrite is two file changes and one claim restated, a
digest churn across forty descendants is forty file changes and no claim at all. Reuses
`classifyNodeChanges` and `classifyDeletions` rather than reimplementing them, so the diff
and the commit path can never disagree about what a claim changing means. When either side
fails to build it says so instead of showing the arithmetic — a rename that forgot to
re-parent its children reported the entire product as withdrawn.

**Shape findings route somewhere.** Every other row type names its next command; `PL091x`
and `PL0920` named none, which is the strand-the-reader failure in a smaller costume. The
footer now offers `llms affected-by` for the finding's subject, since what makes a shape
finding legible is the lineage under it rather than the finding's own text.

The restructuring these smells recommend and the tool cannot perform stays unbuilt. The three
candidate shapes for it are a comment above the `imbalance` detector in `src/smells.ts` —
beside the code that generates the advice — rather than a document. A standalone file has
nothing keeping it honest: no test fails when it drifts, no diagnostic points at it, and no
reader passes through it on the way to the thing it describes.

## 0.18.0

`check` and `ship` print a summary by default. `--full` restores every finding with its
repair, and `frontier` is unchanged.

The full blocks were never wrong — each carries its repair, its question, and the set it
refers to. They are the wrong thing to open with. One `PL0201` prints its question, its fix,
the four asking formats, the statement style, the shape rule, the vocabulary rule, and twenty
sibling nodes, so the first fifteen lines of `check` on a real repository were one finding's
remediation prose and nothing else. A reader heads the output anyway.

- **Ordering is severity, then level.** Severity first because an invalid graph is not an
  incomplete one, and shape findings read off a graph that does not parse are noise — the
  same rank the exit code already uses. Level second because a problem decides what
  everything beneath it is even for. A finding about the repository rather than a layer sorts
  after the layers instead of pretending to be the shallowest.
- **Rows fold by code and level**, and carry a count and a first subject, so a row is
  actionable without expanding it. `PL0901` expands per level instead of folding: sixteen
  drafts are not one job, they are a context job and then a product job.
- **Everything held back is named** — rows past the limit, findings scope deferred, and every
  `smells.ignore` that was honoured, with its reason. A list that stops without saying so
  reads as a whole list.
- **Smells join what `check` reports** and stay out of what decides its exit code.
- **`frontier` is never summarized.** Its whole job is to hand over the next node to write
  with the template, the question, and the siblings to read first; a one-line row would
  delete exactly what it exists to deliver.
- Labels are derived from the diagnostic code, so a new code needs no table entry.

**The commit seam gets two messages, and they never blend.** A refusal carries nothing but
the refusal; a list of unrelated opportunities beside it buries the one thing that has to be
read. A pass carries what to do next — the commit is the one moment the tool is certain to be
read, and until now a clean one printed nothing at all.

- **Refusals rank by cause, not by level.** Every entry is an error, so severity cannot sort
  them, and a node's level says nothing about what to fix first. What ranks them is what
  fixing one makes knowable: a file that does not parse contributes no node, so the graph
  built without it is missing parents that exist on disk; a graph that does not build has no
  lineage, so every digest over it is meaningless. Groups below a broken group are unknown
  rather than also-wrong, and several vanish when the one above is repaired — which the
  footer says, because otherwise a reader treats the list as a checklist and starts wherever
  looks cheapest.
- **Two collapses inside a group, chosen by shape.** Many subjects sharing one repair become
  one line: twelve stale nodes and one `knowledge sync` is a single instruction printed
  twelve times. One subject with several faults becomes one line naming all of them, because
  they are fixed in one edit and splitting them makes one job look like three. Subjects sort
  by how broken they are.
- **Context commands follow the group order**, not the input order. Derived from input order
  they offered lineage for the stale nodes in the last group — the one already collapsed to a
  single command, and the only one nobody needs to read a file to repair.
- **The brief is three rows**, because it fires on every commit and a fifteen-line wall is
  read for a week and skipped forever after. Ordered by leverage rather than by locality:
  what you just touched is rarely the highest-value thing to fix next, and scoping it to the
  diff would turn a flywheel into a janitor.
- **The brief reads the staged tree**, via a new `inspectSnapshot`, because it describes the
  state the commit is about to create rather than whatever is on disk beside it.
- What scope deferred and what `smells.ignore` silenced are named in one collapsed line —
  a quiet report and a configured-quiet report look identical otherwise.
- `commit check --staged --full` restores the flat blocks.

**`frontier` hands over one work order, and the surfaces above it route into it.**

It was the last flat dump, and the worst one: `frontier` carries the node template, the
level's authority question, the siblings to read before writing a duplicate, the terms in
scope, and four authoring rules — around forty lines per node, because it is meant to be
handed to whoever writes the node next. Seven obligations was 669 lines, the same wall the
summary exists to prevent, one level down.

- **One obligation by default**, the shallowest required level, ties broken on the id so two
  runs agree — a work order that moves between runs cannot be handed to anyone. The count of
  what is waiting follows it.
- **`frontier <node-id>`** gives the work order for a specific obligation, which is what a
  summary row leaves you wanting. **`frontier --full`** gives every one.
- **`check` and the commit brief print `product-lint frontier`** when any finding is a
  frontier obligation. A row that names a missing node is not a repair to read, it is a node
  to write, and without the line the summary says what is wrong and strands you there.
- Ordering moved out of the CLI into `orderedObligations` / `obligationsFor`, where it is
  testable and where the rest of the frontier logic already lives.

## 0.17.0

The harness for product smells, with one smell in it.

Every check before this one is local — `PL0201` asks whether this node has a child at
Behavior, `PL1104` whether this node's parent exists. None of them look at the distribution,
so a graph can pass `ship` with exit 0 and still be badly shaped.

Built as scaffolding first, deliberately. A smell is a *calibration* rather than a mechanism:
"one node holds most of a level's children" has no meaning a unit test can settle, and its
only real test is whether it fires where a person agrees there is a problem. So the shape of
the thing lands now, on one smell, and the rest arrive as entries rather than as architecture.

- **`product-lint smells [--all] [--json]`**, exit 0 always, on the same standard as
  `vocabulary`: a review surface, never a gate.
- **Every finding states what would make the shape correct.** `whenFine` is a required field
  on a finding, not a convention. These are all "usually fine, sometimes a tell", and a
  report that only accuses teaches its reader to skip it.
- **Two rules belong to the harness, not to any smell.** Draft nodes are invisible, because a
  freshly adopted repository is N identical chains and every distribution metric would fire
  on scaffolding — the report would be useless exactly when someone first reads it. And
  out-of-scope nodes are invisible and counted, the same contract as everywhere else. Both
  are applied once, so no future smell can get either wrong.
- **`PL0910 IMBALANCE`**: one node holding most of a level, with its share and its thin
  siblings, guarded by a minimum of three parents and five children so the first repository
  to adopt this does not open on a false finding.
- **Thresholds are fixed and versioned, never configurable**, on the same standard as
  `STOPWORDS`. A threshold a reader can tune is a threshold that gets tuned until the report
  is empty, which is a suppression list wearing a number.
- **`smells.ignore`** turns a smell off globally or for one node, and `because` is required —
  refused at load the way a reasonless `scope` is. There is deliberately no predicate
  language over graph properties: that is an engine to maintain, and the cases it could not
  express are the ones where the smell is telling the truth.
- **`PL1402 UNKNOWN_SMELL`**, error: an ignore naming a smell this version does not detect
  silences nothing, quietly.
- Ordering is the harness's job too — shallowest level first, because a problem decides what
  everything beneath it is even for.

## 0.16.0

Survive day one in a repository that already has code in it. Two things made that
impractical, and neither was about the graph being wrong.

**You could not defer a problem.** Every node owed a descendant at the next level and every
governed file owed a Mechanism owner, so a repository with nine problems owed nine subtrees
before `check` went quiet.

**You could not commit while adopting.** `PL2101 UNMAPPED_STAGED_FILE` refuses an edit to a
file no Mechanism owns; the repair is a Mechanism, which needs an Architecture parent, up to
a problem that may not exist. On a 341-file repository that is a wall on the first edit.

- **`scope.roots`**, with a required `because`. `loadConfig` refuses a scope without its
  reason the way it refuses invalid JSON — deferring seven problems is a product decision,
  not a setting. Absent means the whole forest, which stays the default.
- **Scope silences obligations, never invariants.** A deferred problem stops demanding the
  levels below it and does not stop being valid, parented, synchronized, or resolvable.
- **The deferred set is the complement of the kept closure**, never the closure of the other
  roots. Those differ wherever a node has more than one parent, which is most real graphs,
  and growing the deferred set downward would defer every node the kept problems share. The
  same trap `sliceForAudience` already documents. That difference is reported as a count.
- **`PL1401 UNKNOWN_SCOPE_ROOT`**, error. A typo in one id would scope the graph to nothing
  reachable and quiet the entire report, which reads exactly like a clean repository.
- **`--all`** widens `check`, `frontier`, and `ship` for one run. It needs no recorded reason
  because it reveals rather than silences.
- **`product-lint adopt <path>... | --all`** writes a draft spine — one placeholder node per
  level, the Mechanism binding the module's files. The logistics pass at once, and what is
  missing is exactly one thing per node: a sentence. That converts a blocked commit into a
  counted debt. `PL2101`'s repair now names it.
- **Clusters are modules**, the first directory beneath a governed root, with one shared
  audience placeholder. One spine per file is thousands of placeholders; one for the whole
  tree is a single trunk, and the point of drafting bottom-up is to see what problems the
  code already implies — a graph with one problem says nothing to revise. A module holding a
  file a real Mechanism owns is split finer so a generated glob never trips `PL0603`.
- **`"draft": true`** on a canonical node, and `PL0901 DRAFT_NODE` grouped by level,
  shallowest first, because that is the order of leverage. In `nodeFingerprint` and not
  `semanticFingerprint`: promoting a node is two edits, and the statement is the one that
  changed the meaning.
- **`ship` refuses while any draft remains.** Not because a draft is invisible — it is the
  most visible thing in the report — but because of what `ship` means. `check` and
  `commit check` pass, because the logistics genuinely are satisfied.
- **`PL0902 DRAFT_LOOKS_WRITTEN`** names a node whose statement is no longer the generated
  one, where only the flag was left behind. This is the hole a flag opens that a marker
  string in the statement does not, and without it `ship` would stay red for finished work.
- **`PL0604 UNGOVERNED_OUTSIDE_SCOPE`** replaces per-file `PL0601` under scope, and is the
  one report that does not gate completeness: an unowned file has no lineage, so nothing can
  say which problem it serves, and demanding ownership would mean building a deferred
  subtree. It stays at full volume so a green `ship` never reads as "every file is owned".
- **`PL1015 INVALID_DRAFT`**: `draft` is `true` or absent. `false` would be a second spelling
  of absent.

`schemaVersion` stays `1`: one optional field is added to canonical nodes.

## 0.15.0

A term records where its word came from and what it beat. Most product nouns are not
coinages — the thing already has a name in information retrieval, in records management, in
scheduling theory — and a naming decision otherwise leaves no trace: you weigh three words,
pick one, and the only evidence is that a different word is present. Nobody can then tell
a name chosen over alternatives from the first word that came to mind.

- **`borrowed`**, one optional string: where the word comes from and how this graph's sense
  departs from it. Free prose because nothing queries it — it is there to be read in
  `frontier` and the `llms` views before a statement is written. Deliberately not an object
  with a `source` slot: a citation field in a set invites completing the set, which is how
  a fluent wrong citation gets written.
- **`rejected`**, required, `[]` legal: the names weighed and passed on, each with a
  `stance` and a reason. Required because absent and empty would otherwise be one byte with
  two meanings, and "nobody wrote it down" reading as "nothing was considered" is what makes
  an unrecorded term useless rather than merely incomplete. A reason is required too — a
  bare list of names is a suppression list, not a decision.
- **`PL1312 REJECTED_TERM_NAME`** refuses a name another term rejected as `wrong`. Not
  "this is a duplicate" — nothing can tell a duplicate wearing the rejected name from a real
  second sense — but "a recorded decision is being contradicted without saying so". Global
  and case-insensitive on the whole name, matching `PL1304`, because marks resolve globally
  and a level-scoped rejection would be incoherent with the notation. A second pass over the
  loaded terms, so the finding never depends on read order. The repair is `PL1304`'s repair,
  a two-word name; deleting the rejection is for a real reversal, and the deleted line is
  then the record of it.
- **`PL0806 REJECTED_NAME_IN_PROSE`** is `PL0801`'s scan pointed at the losers: a `wrong`
  name written unmarked at the term's level or deeper. Info, in `vocabulary` and in
  `commit check --staged`.
- **`stance` splits two different facts.** `wrong` says the word does not name this thing
  and is guarded by both diagnostics. `taken` says the word already names something else
  here and is recorded, never enforced. Rejecting a name because it is spoken for is common
  and correct, and it predicts that the word goes on being used — and eventually declared —
  for that other thing; guarding it would fire on the case it was written to describe, and
  the only clean repair would be deleting a true record. Against the graph this was designed
  for, two `taken` names accounted for ten prose occurrences, every one legitimate.
- **Neither field joins `semanticTermFingerprint`.** Discovering that your word matches an
  established one changes no statement's meaning, and neither does writing down a name you
  passed on; both changes classify as synchronization-only. Editing the `definition` to
  match a borrowed sense still propagates. Without this line, attaching origins to an
  existing vocabulary would restate the whole graph for no change in meaning, and would
  simply not get done.
- The fourth authoring rule gained both, so an agent writing prose is told to record the
  losers while it is choosing rather than after.
- **`product-lint term reject <term-id> <name> --wrong|--taken --because <reason>`.**
  Required `rejected` reaches exactly one moment, the term's creation, and alternatives are
  usually weighed later — while writing a statement, about a term declared months ago and
  not open. Recording one then costs finding the file and matching an array shape, which is
  more than the decision cost, so it does not happen and the alternative is gone. Exactly
  one stance is required and never defaulted: which one it is decides whether the name is
  guarded or merely recorded. The write is refused with the diagnostic it would have caused
  rather than a command-time family of its own, so rejecting an already-declared name as
  `wrong` reports `PL1312` before the file changes, and names `--taken` as the fit.
- **No `term add`.** It was proposed and cut: every failure a scaffold would prevent is
  already named by `PL1302`, `PL1305`, `PL1306`, and — now that the field is required —
  `PL1301` for a missing `rejected`. What was left is convenience for an agent that writes
  JSON well against a linter that reports every mistake immediately.
- **Fixed**: `PL1301 INVALID_TERM`'s repair listed the fields of a term node and would have
  gone on omitting `rejected`, telling a reader to write the file that produced the error.

`schemaVersion` stays `1`: one required field is added to term nodes, which existing term
files satisfy with `"rejected": []`.

## 0.14.0

Vocabulary may be declared at every level. Terms began at product on one argument —
context describes the member's world before the product exists, in the world's words, so
a coined noun cannot appear in a statement that stays true if you build nothing. That
argument is about where a word may be *spoken*, and `PL1308` already enforces exactly it.
Stating it a second time as a list of permitted levels got a real case wrong: a context
level of thirty-four problems, ten of them instances of two ideas, could either name those
ideas ten times in unenforced English or declare them at product, where no context
statement can reach them.

- **`TERM_LEVELS` is deleted, not widened.** A term's level is a `KnowledgeLevel`, the same
  list a node's level reads. A second list that has come to hold the same six values is
  two names for one thing, and the next reader has to prove they still agree.
- **Audience is in too**, deliberately. The argument for context — the level list was
  `PL1308`'s rule restated in the wrong place — does not stop at context. The concrete
  worry, that a level of a few one-line glosses may have no statement that needs a coined
  word, is a claim about one graph, and the tool already answers it per graph: `PL0805
  TERM_UNUSED_AT_ITS_LEVEL` names a term declared where nothing at that level marks it.
  A report beats an enum here, and it is the report that is load-bearing.
- **Where a word may be spoken did not move.** `PL1308 TERM_FROM_BELOW` is unchanged: a
  product term marked in a context statement is still an error. Widening where a name may
  be coined made that case reachable instead of impossible, so it is now held by a test
  rather than by arithmetic.
- **`PL1309 TERM_LEVEL_FORBIDDEN` is removed.** It refused the declaration levels this
  release allows and can no longer fire. A diagnostic that cannot fire documents a rule
  the tool does not have.
- Nothing else needed widening: term discovery, level ordering, the digests, and the
  report each already read the level list rather than the four names. `docs/context/terms/`
  and `docs/audience/terms/` load, `knowledge sync --staged` maintains `vocabularyDigest`
  on a context node exactly as on a product node, `PL0801`'s walk starts at the term's own
  level wherever that is, and `product-lint vocabulary` counts every level.
- **Fixed**: `schema/canonical-node.schema.json` forbade `sync.vocabularyDigest` under
  `additionalProperties: false`, a field 0.12.0 began writing — so any editor honouring
  `$schema` flagged every node that marks a term. `validate` always accepted it; only the
  published schema was wrong.

`schemaVersion` stays `1`: no node shape changed, one field's value domain widened, so
existing graphs are valid unchanged with no migration step. 0.13.0 and earlier reject a
graph that declares a term at audience or context — update the pinned copy before
authoring one.

## 0.13.0

Deletions leave a record shaped like a deletion. A node could leave the graph without a
trace as long as it was nobody's parent: a leaf deletion dangles no edge, the frontier is
a boolean, and the required `Knowledge-Change:` trailer reads identically to an edit's —
which is how an approved law was lost inside a hundred correct lines and restored by hand
only because a person happened to reconcile a sidecar table.

- **Two new trailers.** `Knowledge-Removed: <id>` declares a deletion whose claim is
  withdrawn; `Knowledge-Renamed: <old-id> -> <new-id>` records one claim restated — the
  deletion of its source and the addition of its target as one event, so the target owes
  no separate `Knowledge-Change` line. Every deleted id must be declared exactly once,
  as removed or as a renamed source. Many renamed sources may share one target: a merge,
  recorded as such. Both names are configurable (`commit.removedTrailer`,
  `commit.renamedTrailer`), like `commit.trailer` before them.
- **The bookkeeping is enforced** (`commit message`): `PL2207 REMOVAL_DECLARED_AS_CHANGE`
  (a deletion dressed as an edit — the camouflage, named), `PL2208
  MISSING_REMOVAL_TRAILER`, `PL2209 SPURIOUS_REMOVAL_TRAILER`, and `PL2210
  UNSTAGED_RENAME_TARGET`. `PL2201` extends across all three trailer kinds. A deletion
  already required a trailer, so this changes the shape of the record, not its price:
  the removal block of a commit is exactly as long as the destruction is wide, separate
  from the change lines, and `git log --grep='^Knowledge-Removed:'` is a standing audit.
- **The classification is reported, never enforced** (`commit check --staged`). Each
  staged deletion is paired against the staged additions: statement similarity at
  PL0802's threshold, or an identical parent set plus at least one shared content word —
  because a real rename usually rewrites the statement and keeps its placement. A paired
  deletion is `PL2109 NODE_RENAMED` carrying the suggested trailer line; textual evidence
  reads as a note, placement-only evidence reads as a question (`ask-user`), because the
  two mistakes are not the same size — a false removal adds a line, a false rename
  suppresses the warning and the loss goes silent. An unpaired deletion is `PL2108
  NODE_REMOVED`, a warning whose question carries the destroyed statement verbatim and
  what its parent keeps. The pairing is a reading, not a fact: the trailer you write is
  the record, and enforcement checks declarations against the diff alone.
- **`PL2110 COVERAGE_NARROWED`**: a child that leaves its parent while staying in the
  graph — the re-parent that quietly abandons a problem. Edge identity, not child counts:
  a sweep replaces what it deletes and the count holds still. Both edge ends follow their
  rename successors, so a pure rename never fires. Deleted children are `PL2108`'s event;
  the two never double-fire.
- Terms participate identically: a deleted `term.*` id classifies by definition
  similarity and takes the same trailers. Non-leaf deletions were never the hole —
  a dangling edge is `PL1102` and fatal — so all of this is scoped to leaves by
  subtraction, not by a test.

## 0.12.0

Vocabulary: terms declared where they are first needed, uses marked in prose.

- A **term** is a seventh node kind, stored inside the level that declares it:
  `docs/<level>/terms/<slug>.json` with an id (`term.<slug>`), a `level`, a surface `name`,
  and a one-sentence `definition` under the existing style rule. A term is a name, not a
  claim: no `constrainedBy`, no frontier obligation. Its only edges are its uses, derived
  from marked statement text and never authored — which is how the feature adds no field to
  any existing node. Terms may be declared at product, behavior, architecture, and mechanism,
  never at audience or context: context describes the member's world before the product
  exists, and a coined noun cannot appear in a statement that stays true if you build nothing.
- **Notation**: a use is the term's name in single asterisks, inline — `the member's *plan*`.
  Two characters, renders as emphasis wherever statements reach markdown, and visible as
  itself in JSON and the terminal. Resolution is case-sensitive except the first character
  and allows the noun inflections `s`, `es` (only after s/x/z/ch/sh stems), and `'s`.
  A literal asterisk escapes as `\*`; anything unbalanced or empty is `PL1311`, an error,
  never a guess.
- **The decidable half is enforced** (`validate`/`check`/commit): a marked word must resolve
  (`PL1307 MISSING_TERM` — marking nothing is legal; the moment you mark, you owe the
  declaration), one name has one declaration globally and case-insensitively
  (`PL1304 DUPLICATE_TERM_NAME` — the homonymy rule; the repair is a two-word rename), and
  vocabulary flows down only (`PL1308 TERM_FROM_BELOW` — a product law written in the
  surface's word is named, which makes the hand-maintained "whose vocabulary" audit a
  diagnostic). Plus the shape codes: `PL1301`–`PL1306`, `PL1309`, `PL1310 TERM_CYCLE`.
- **Definitions join the digest machinery.** A node whose statement marks terms carries
  `sync.vocabularyDigest` over the sorted (id, meaning) pairs of the terms it marks; a term
  whose definition marks terms carries the same. Changing a definition goes stale everywhere
  the word is spoken (`PL2004 STALE_VOCABULARY`), `knowledge sync --staged` rewrites, and the
  commit path holds the set together: a definition edit is a semantic change taking a
  `Knowledge-Change: term.<slug>` trailer with every marking text staged beside it (`PL2103`
  extended through marks). A separate digest field rather than a fold into
  `constraintsDigest` because the repairs differ: stale constraints mean re-read your
  parent's claim, stale vocabulary means re-read the definition of a word you use. Nodes
  that mark nothing carry nothing, so an adopting repository's files stay byte-identical.
- **The judgement half is reported, never enforced** — new `product-lint vocabulary
  [--staged]`, exit 0 always, in the spirit of `contested`: `PL0801 UNMARKED_TERM_USE`
  (a declared name unmarked at the term's level or deeper — never shallower, never verb
  forms, never inside quotes; grouped one block per term the way a long file list folds
  into a tree), `PL0802 SYNONYM_CANDIDATE` (two definitions written in mostly the same
  words), `PL0803 CAPITALIZED_UNDECLARED` (the migration seed: mid-sentence capitals are
  the convention statements were already half-using), `PL0804 UNUSED_TERM`, and
  `PL0805 TERM_UNUSED_AT_ITS_LEVEL`. The scan carries no dictionary: zero declared terms,
  zero noise, which is what makes an undeclared term legal forever.
- **Commit-scoped visibility**: `commit check --staged` prints `PL0801` for statements
  changed in the staged diff only, info severity, exit codes untouched — the one moment the
  mark costs two characters in a file already open and already owed a trailer. The standing
  backlog stays in the report command.
- **A fourth authoring rule**, `vocabulary`, beside style, shape, and placement — the fourth
  scope: checked by reading a sentence beside the declared terms. It rides the same
  node-adding diagnostics and both `llms` views, and the frontier now prints the **terms in
  scope** at the target level beside the level's nodes, for the same reason the level
  prints: synonym prevention happens before the write, and a rule about a set the reader
  cannot see is advice, not information. The `llms` views also carry a `# Terms` section
  with the definition of every term the shown statements mark.
- `knowledge affected-by term.<slug>` lists the blast radius of a definition change or
  rename: every statement and definition that speaks the word.

## 0.11.0

A third authoring rule: which level a statement belongs at.

- New `LEVEL_PLACEMENT` constant and a `placement` field on `Diagnostic`. It rides the same
  codes as `NODE_SHAPE` — the ones about to make an agent add a node — and prints under
  `placement:`. The two existing rules cannot catch what it catches: a node that is well
  written, that overlaps no sibling, and that sits one level too deep reads correct all
  three times it is looked at.
- The rule decides a level by what would FALSIFY the statement, never by what the statement
  is about. Every level talks about the same product, so a subject matter test leaks at every
  boundary; each level owns exactly one class of change, so the falsifier does not. It carries
  that change per level, the tie-break that makes the assignment unique (the shallowest level
  whose change would falsify it), and the pair check — a child must be able to be false while
  its parent stays true.
- `PL0011 MISSING_AUDIENCE` carries no placement rule, for the reason it takes its own shape
  rule: the pair check compares a node with its parent, and an Audience node has none.
- The Behavior question now asks for the occasion: "What must a user, client, or system
  observe or do, and on what occasion, because this product rule holds?" It used to ask what
  someone "should be able to" observe or do, which is answerable by restating the Product rule
  with a modal in front of it — a capability is a promise with a modal in front of it. That
  fills the level without adding a claim, and the level below it then has nothing to constrain.
  Product holds everywhere and Behavior happens somewhere, so the question asks for when.
- The `knowledge file` and `knowledge affected` LLM views carry the placement rule too. The
  shape rule travels with them because a slice hides the level; the placement rule travels for
  the opposite reason — a slice IS a lineage, so it is the one view where the parent is on the
  page and the pair check can be run against the material instead of from memory.

## 0.10.0

Audience becomes a level, structured as n sets rather than one.

- New root level `audience`, above Context. The graph is now
  `Audience -> Context -> Product -> Behavior -> Architecture -> Mechanism`. Context used to
  ask "who is this for, AND what problem are they solving", which is two claims that can be
  false independently — the same fault the one-thing rule forbids inside a statement. Context
  now asks only why.
- The level is **n MECE sets**, not one set of nodes: `audience.<set>.<value>`. A Context names
  a selector over them, OR within a set and AND across sets, so `[role.admin,
  segment.enterprise]` is enterprise admins and only them. Modelling the axes as independent
  parents cannot express that — a list of parents is a union, so an SMB admin and an enterprise
  member would both reach it. Modelling audiences as flat tuples can, but needs one node per
  combination and one parent per covered combination; at three axes that is 18 nodes and up to
  18 parents on a single Context, against 8 and 2 here.
- `audience.<set>.*` names a set rather than its members, and carries the set's **membership**
  as its fingerprint. Listing every value instead means the same thing today and a different
  thing tomorrow: nothing a node named changes when a value is created beside them, so the
  digest holds, `check` stays green, and the node stops covering everyone while still claiming
  to. Measured on a real repository before the wildcard existed — the digest was byte-identical
  across the set growing, and the only diagnostic was about the new value, which went away as
  soon as anyone modelled it.
- New `product-lint knowledge slice <set=value,...>`. The mock set is the complement of the keep
  closure, never the closure of a mock root. They differ whenever a node has more than one
  parent: on the graph this was designed against, growing the mock set downward from "everyone
  else" stubbed 2 of the 3 files the kept audience needed. `contested` reports that difference
  rather than resolving it silently.
- New `PL2107 AUDIENCE_WIDENED`, a warning. Audience below Context is the union of a node's
  parents, so adding a parent can only widen, and it does so without changing a word of the
  node. That is the mirror of the reason wildcards exist — in both cases the meaning moves
  while the statement stands still — except this one is decidable from the two graphs, so it
  is reported rather than instructed.
- The frontier now decides audience coverage by selector, not by child edge. A wildcard leaves
  no edge to any single value, and a Context naming one set leaves none to the other set's
  values at all, so reading edges called every value covered by description uncovered. Caught
  end-to-end, not in review: a correct four-value graph reported two of them missing.
- `src/graph.ts` and `src/commit.ts` no longer hardcode `context` as the parentless root or
  re-spell the level list. `KNOWLEDGE_LEVELS` was not the single source of truth it read as,
  and both would have silently governed the wrong level.
- `for-file` and `affected-by` now print the **resolved** audience. The lineage lists the
  audience nodes it passed through, and a wildcard is not a node, so a file reached through one
  showed whatever other audience parent it happened to have and read as scoped to it. On the
  README's own graph `src/approval/approve-version.ts` listed `role.admin` and `segment.studio`
  while actually serving everyone.
- An audience prints as `role=admin, segment=studio`, naming only the sets that constrain it,
  and `everyone` when none do. Terms another term already covers are absorbed, in the resolver
  rather than at the end — a redundant term would otherwise be copied into every node below it,
  growing the disjunction down the graph while describing the same people.
- `PL0011` carries its own `shape` rule. The general one tells an agent to keep the level a
  single non-overlapping set, which here produces one node per combination — the shape sets
  exist to avoid — and its repair for a duplicate is "add your parent to its constrainedBy
  instead", which cannot apply to a node with no parents.
- `PL1005`, `PL1010`, and `PL1103` named the five old levels in their repair text. `PL1010`
  told an author that a Context node uses an empty `constrainedBy`, which is now wrong twice
  over.
- The README is rewritten around one graph. It previously described three different products —
  video review, an orders service, and the SSO example — so no query example could be read
  against the graph the example before it established. Every command output in it is now real
  output from the single graph in "The example used throughout".
- Term absorption in `resolveAudiences` is pinned by a test rather than by a comment. The
  suite passed with the call removed, which made the comment the only thing holding the
  invariant up — and it is the kind of line that reads as a no-op, because `formatAudience`
  absorbs as well, so the printed scope is identical either way and only the inherited term
  count differs. Both this and the frontier's selector-based coverage were confirmed by
  reverting each and watching the new tests fail.
- New `src/audience.ts` and `test/audience.test.mjs`. Audience is held in disjunctive normal
  form: sets are closed under intersection and not under union, and inheritance below Context
  is a union, so a node carries a list of terms bounded by its distinct Context ancestors —
  never by the size of the product of the sets. A 630-node graph over a 15,625-tuple space
  resolves in 31ms and answers a slice in 1ms, because the tuple space is never constructed.

## 0.9.0

`init` now checks what it provisioned, instead of telling you to.

- After provisioning, `init` runs the working-tree read behind `check` and exits with its
  result. It used to end on `Run: npx product-lint check`, which spent the one moment the tool
  has the user's attention on an instruction rather than an answer. The adoption install is the
  case that makes this matter: `init` creates six empty level folders beside a `docs/` tree that
  may already hold nodes, and nothing had read them.
- `init --json` gains a `check` object beside `created`/`skipped`/`notes`, carrying `complete`
  and the annotated diagnostics — the same shape `check --json` returns.
- `init` therefore exits 2 on an empty repository, where it used to exit 0. That is the honest
  answer, and it is the answer `PL0001 MISSING_CONTEXT` was written to give: a fresh repository
  is incomplete, and saying so is the whole reason that diagnostic exists rather than a "you are
  set up" line. A script running `init` under `set -e` stops there now, so the text output names
  the boundary — `provisioning done. checking the working tree:` — because an unlabelled
  diagnostic printed under a list of created paths reads as a failure to create them.
- `check`, `frontier`, `ship`, and `init` now read through one `statusReport`. They had one copy
  of the ordering and exit-code rules between them, and a second copy in `init` would have been
  free to drift — an `init` that disagreed with the `check` it tells you to run makes both
  untrustworthy.
- New `test/init.test.mjs`. `init` had no test at all, including for the provisioning it already
  did. The agreement between `init` and `check` is asserted directly rather than left to the
  shared call, since the sharing is what a later edit would undo.

## 0.8.0

The shape rule now arrives with the set it refers to.

- `PL0101`, `PL0201`, `PL0301`, and `PL0401` carry `details.level`: the id and statement of every
  node already at the level they are about to add one to, capped at twenty with the total stated.
  `NODE_SHAPE` has always said to read the nodes already at that level before writing a sibling,
  and nothing showed them. That gap has a measured cost — an agent mined a level it had not
  re-read and produced three duplicate pairs and one subset, each of which read correct alone.
  A rule about a set the reader cannot see is advice, not information.
- `formatDiagnostic` renders it, so it reaches the pre-commit hook rather than only `--json`.
  This matters more than a command would: the frontier already runs on every check, so the level
  arrives without anyone choosing to ask for it.
- New `test/invariants.test.mjs`. The frontier and `knowledgeForFile` each decide which governed
  files have no Mechanism owner, using the same predicate spelled twice, and nothing tied them
  together. A consumer can use their disagreement as a self-check — if the frontier reports every
  file owned and the query names an owner for none, both cannot be true, and the wrong half is
  the reading rather than the data. That check is only sound while the two agree, so the contract
  is asserted rather than left to coincidence. Tested where the set is non-empty, since two empty
  sets are equal for free.

## 0.7.0

Removes the spectrum and the ratchet, which 0.5.0 added and nothing needed.

- `product-lint spectrum`, `product-lint accept`, `.product-lint/baseline.json`, and diagnostics
  `PL0901` through `PL0908` are gone. The ratchet counted three things and refused a commit that
  raised any of them. All three were already errors that already refused the commit: an
  unowned staged file is `PL2101`, an overlapping Mechanism is `PL0603`, and a graph that does
  not build stops `commit check` before it reaches anything else. The ratchet re-detected what
  the validator had already caught, and said it worse — "COVERAGE went 0 to 1" names no file and
  no repair, where `PL2101` names both.
- A ratchet earns its place against a measurement too soft to block on, which is what it was
  designed for. Those measurements were dropped in 0.6.0 for firing on most of every real graph,
  and the scaffolding outlived the thing it was holding up.
- The staged and head snapshots no longer filter `.product-lint/`. That filter existed to keep a
  committed baseline from governing itself, and there is no baseline now.
- `PL0603 OVERLAPPING_MECHANISM` is unaffected. It is the one check from this line of work that
  decides something nothing else decides.

## 0.6.0

Removes cohort attestation, which 0.5.0 added one release earlier.

- `docs/attest/`, the `attest.levels` config key, and diagnostics `PL0801` through `PL0804` are
  gone. It recorded that somebody had read a level, and went stale when the level changed. The
  idea was sound and the shape was wrong: it introduced a document type whose only content was a
  fact about a person, and no machinery could maintain it — a rename orphaned the record, a
  deletion stranded it, and the digest had to be copied by hand out of a diagnostic. Any
  automation able to refresh that digest would have refreshed the review along with it, which is
  the one thing it could not do and still mean anything.
- `src/extent.ts` goes with it. It existed only to build cohorts, and nothing else called it.
- Nothing else changes. `PL0603`, `spectrum`, and `accept` never depended on it.

## 0.5.0

Shape, enforced where it is decidable and recorded where it is not. A level is meant to be a set
of nodes that do not overlap. Between two statements that has no test. Between two Mechanism
nodes it has one, because a Mechanism binds to files.

- New `PL0603 OVERLAPPING_MECHANISM`, an error, when two Mechanism nodes resolve to the same
  file. This is evidence, not a reading, and it is held to the standard `PL0502` already meets.
  When one node's files sit entirely inside another's the message says so, because the repair is
  a merge rather than a re-partition. **This can fail a repository that passed 0.4.0.** Ambiguous
  ownership was always a defect; nothing named it. It also has a cost the tool never explained:
  `commit check` requires every owner of a changed file to be staged, so a file with two owners
  silently doubled the `PL2102` burden.
- New `product-lint spectrum`, reporting each measured property as its own number. A property
  that could not be measured reports as masked and carries no number at all — never zero. The two
  are different facts, and a tool that prints one for the other reports success over work it
  never looked at. `check` and `ship` print the same vector as a footer.
- New `product-lint accept --reason "<why>"`, recording the current counts as a floor in
  `.product-lint/baseline.json`, and a check at commit time that no property got worse. Held per
  property and never summed: a total would let a commit that closes two coverage gaps pay for the
  overlap it opens. Lowering the floor is free. Raising it needs `--allow-regression` and lands
  the stated reason in a committed file, where review can see it. `accept` refuses on a dirty
  tree, and the hook never writes the baseline — a step that rewrites a committed file behind the
  author is not a record of anything.
- New cohort attestation. A cohort is the children of one parent at one level, which is the unit
  at which exclusivity is a question at all. Its digest covers member ids and their semantic
  fingerprints, so it moves when a member is added or restated and stays put when a digest
  elsewhere is resynchronized. A cohort with no recorded review, or one that changed since its
  last review, is reported — `info` during `check` and `commit check`, `error` at `ship`. The
  tool never learns what the reviewer concluded, only whether they read this text. On by default
  at product, behavior, and architecture; set `attest.levels` to `[]` to turn it off. Mechanism
  is excluded because `PL0603` already decides the part of it that files can settle.
- `NODE_SHAPE` and `STATEMENT_STYLE` now ride the two attestation diagnostics. Everywhere else
  the shape rule arrives before a node is written; here it arrives with the whole set in front of
  the reader, which is the only position the rule can actually be applied from.
- Glob patterns compile once and are reused. Matching is the hot path, and a Mechanism list
  checked against a large snapshot recompiled the same few patterns once per file. The test suite
  runs in roughly half the time.
- The exhaustive-fix test now walks `src/` recursively. It read one directory level, so a
  diagnostic declared in a subdirectory would have shipped with no repair text and nothing would
  have failed.

## 0.4.0

Shape. A tool that tells an agent to create a node, and does not say what a node should be,
gets the two nodes it did not ask for: one that states two things, and one that repeats what a
sibling already says. Both read correct on their own.

- `STATEMENT_STYLE` gains the one-thing rule, so it reaches an agent everywhere the style rule
  already did — the `style` field on 8 diagnostic codes, and the `llms` footer.
- New `NODE_SHAPE` constant and a `shape` field on `Diagnostic`, carrying the rule that each
  level is a set of small non-overlapping nodes that covers the level, and that a second node
  saying what a sibling says should instead be a second parent on the first. Annotated onto the
  five `MISSING_*` frontier codes and `PL1009 MISSING_STATEMENT` — the diagnostics that are
  about to add a node — rendered by `formatDiagnostic`, and present in `--json`.
- `shape` is deliberately not folded into `style`. One is checkable by reading a sentence; the
  other only by reading the level. It is also not enforced: mutual exclusivity between two prose
  statements has no deterministic test, and a guess that blocks a commit is worse than a rule
  that instructs.
- `product-lint llms` carries `shape` as well as `style`. That view is a slice — it shows a
  lineage and never a level — which is the exact position from which a duplicate sibling gets
  written.

## 0.3.0

Adoption. Every item here came out of one real install into a repository that already had
341 governed files, where `init` printed a success list and wired nothing.

- New `PL2106 UNGOVERNED_IMPLEMENTATION`, replacing `PL2101` when the graph has no
  Architecture level. `PL2101` says "create a Mechanism node", and `PL1104` forbids a
  Mechanism with no Architecture parent, so on a graph that stops short of Architecture the
  tool told an agent to build a node it would then reject — once per staged file. A
  repository adopting Product Lint with code already in it got N wrong instructions and no
  right one, because the frontier diagnostic that names the true next action is not part of
  `commit check` output. `PL2106` is emitted one time, names the shallowest absent level,
  carries that level's question and `infer` flag, lists the ungoverned files in
  `details.files`, and says to narrow `governedPaths.include` while adopting. `PL2101` is
  unchanged once an Architecture node exists.
- New `PL0602 UNGOVERNED_TREE` from `frontier`, `check`, and `ship`, replacing the per-file
  `PL0601` flood on a graph with no Architecture level, for the same reason. `ship` on a
  repository with 317 unowned files used to report `PL0001 MISSING_CONTEXT` alone and
  nothing else, because the missing-Context branch returned before it ever counted the
  files — so the one number that says how big the job is was never printed.
- Any diagnostic carrying `details.files` now renders them as a directory tree. Above 30
  files the tree switches to per-directory counts, which is the readable answer at that
  size: "src/lib/ai holds 88 of them" locates the work, and eight names out of 317 do not.
  Every limit in the tree is stated in the output, because a tree that silently stops reads
  as a complete list.
- `product-lint <command> --help` now prints usage. `--help` was a declared option that
  nothing read, so `product-lint check --help` loaded the config and ran the check.
- `init` no longer reports a half-install as a success. Its two hook decisions are now
  independent: a project that already defines `pre-commit` but not `commit-msg` used to get
  the `commit-msg` block appended and no warning at all, because the "add these manually"
  note was printed only when *both* hooks already existed. The pre-commit commands were
  never wired and nothing said so.
- `init` no longer replaces lefthook's error with a guess. Every failure used to report as
  "Could not run lefthook automatically. Install it: npm install --save-dev lefthook", which
  is a wrong diagnosis for the common case — a repository with `core.hooksPath` set already
  has lefthook, and lefthook prints the exact flag that fixes it. lefthook's own output is
  now shown, and the `core.hooksPath` case names `npx lefthook install --force`.
- `init` now checks that the hook scripts exist in the repository's hooks path and says so
  when they do not. A block in `lefthook.yml` with no script behind it is a dead hook, and
  both halves failed independently on the same install.

## 0.2.0

Breaking. A repository whose Mechanism nodes claim a path that matches nothing now fails
`validate` and `check` with exit 1 where it previously passed. That is the point: the
claim was already false and the tool said nothing.

- New `PL0502 DEAD_IMPLEMENTATION_PATH`, one diagnostic per dead entry, naming the entry.
  A Mechanism that lists two paths and resolves one used to report as valid and complete,
  because every entry was collapsed into a single match. Each entry is now checked on its
  own. A glob that matches no file is dead like any literal path.
- `PL0502` is emitted from `validateSnapshot`, so plain `product-lint validate` catches it
  and not only `check`. A node whose entries are *all* dead still reports `PL0501
  MISSING_IMPLEMENTATION` alone, which states that fact better.
- `knowledge sync --staged` now prunes an implementation entry when the staged change
  proves it is gone: a literal path HEAD had and the index does not. Deleting a governed
  file previously rewrote only the owner's digest and left the orphaned claim behind, so
  the tool manufactured the very dead path it now reports. Nothing else is ever pruned. A
  typo was never in HEAD, and a path moved outside a hooked commit is in neither, so both
  keep reporting `PL0502` rather than being silently dropped.

## 0.1.0

First public release.

Knowledge model:

- Five-level JSON knowledge DAG: Context, Product, Behavior, Architecture, Mechanism.
- Continuous top-down lineage and frontier diagnostics.
- File-to-knowledge and node-to-affected-files traversal.
- Mechanism ownership of implementation paths.
- Deterministic staged implementation and constraint digests.
- Git-anchored reference JSON validation.
- Query-scoped LLM text views.

Commits and hooks:

- Bidirectional staged commit validation.
- Exact `Knowledge-Change` Git trailer enforcement.
- The commit subject is unconstrained, so any team convention composes with it. Opt in to
  enforcing your own with `commit.subjectPattern` (`PL2205`, `PL2206`).
- `product-lint init` provisions the whole setup: `docs/` with a `.gitkeep` per level,
  Lefthook `pre-commit` and `commit-msg` commands (created, or appended to an existing
  config), and `lefthook install`.
- The pre-commit hook runs `knowledge sync --staged` and re-stages `docs/`, so no manual
  sync-and-restage step is needed.

Diagnostics:

- Every diagnostic carries a specific `fix`. A test fails if a new code ships without one.
- Diagnostics that need an answer from the user carry an `ask` field with three formats:
  draft to confirm, candidates to choose, and decision brief. Each costs the user a
  confirmation or a choice rather than an essay.
- Diagnostics that ask for prose carry a `style` field requesting ASD-STE100 Simplified
  Technical English. `product-lint llms` output carries the same rule.
- A missing configuration file reports `Run: npx product-lint init` rather than a raw
  `ENOENT` stack trace. Set `PRODUCT_LINT_DEBUG` for full stacks.
