# Changelog

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
