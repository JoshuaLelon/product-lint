# Changelog

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
