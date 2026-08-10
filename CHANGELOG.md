# Changelog

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
