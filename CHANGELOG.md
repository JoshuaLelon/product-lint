# Changelog

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
