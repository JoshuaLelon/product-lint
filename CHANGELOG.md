# Changelog

## Unreleased

- Every diagnostic now carries a specific `fix`. Previously 10 of 47 codes offered any
  remediation and 37 gave a message only, so an agent had to infer the repair. A test
  fails if a new code ships without a fix.
- Diagnostics that ask for prose now carry a `style` field requesting ASD-STE100
  Simplified Technical English, and name the Claude Code writing skill. `product-lint
  llms` output carries the same rule.

- Removed `kind` from canonical nodes. `level` already carries the structural
  classification, and no rule ever branched on `kind`. Reference nodes keep their `kind`,
  which is their only classifier.
- `product-lint init` now provisions the whole setup: `docs/` with a `.gitkeep` per level,
  Lefthook `pre-commit` and `commit-msg` commands (created or appended to an existing
  config), and `lefthook install`.
- The pre-commit hook now runs `knowledge sync --staged` and re-stages `docs/`, removing
  the manual sync-and-restage step.
- Documented that the commit subject is unconstrained, and added the opt-in
  `commit.subjectPattern` for teams enforcing their own convention (`PL2205`, `PL2206`).
- Fixed a type error in `src/cli.ts` that made `tsc` exit non-zero and blocked
  `npm pack` and `npm publish` via `prepack`.
- A missing configuration file now reports `Run: npx product-lint init` instead of a raw
  `ENOENT` stack trace. Set `PRODUCT_LINT_DEBUG` for full stacks.

## 0.1.0

Initial package scaffold.

- Five-level JSON knowledge DAG: Context, Product, Behavior, Architecture, Mechanism.
- Continuous top-down lineage and frontier diagnostics.
- File-to-knowledge and node-to-affected-files traversal.
- Mechanism ownership of implementation paths.
- Deterministic staged implementation and constraint digests.
- Bidirectional staged commit validation.
- Exact `Knowledge-Change` Git trailer enforcement.
- Git-anchored reference JSON validation.
- Query-scoped LLM text views.
