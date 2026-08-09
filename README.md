# Product Lint

Product Lint is a deterministic guardrail for building product knowledge alongside code.
It stores canonical knowledge as a five-level JSON DAG:

```text
Context -> Product -> Behavior -> Architecture -> Mechanism -> repository files
```

Git stores history. Product Lint validates the current graph, detects the next missing
level, synchronizes staged implementation and knowledge changes, and enforces structured
commit trailers for semantic knowledge changes.

It does not use an LLM. Its diagnostics are designed so coding agents know when to ask the
user instead of inventing product intent.

## Install

```bash
npm install --save-dev product-lint lefthook
npx product-lint init
npx product-lint check
```

`init` writes `product-lint.config.json`, creates `docs/` with a `.gitkeep` per level,
adds Product Lint's `pre-commit` and `commit-msg` commands to your Lefthook config
(creating it, or appending to an existing one), and installs the Git hooks. Running it
twice is safe.

`product-lint check` exits with:

```text
0  valid and complete
1  invalid
2  structurally valid but incomplete
```

An empty repository therefore produces a machine-readable `MISSING_CONTEXT` diagnostic
rather than encouraging an agent to start from implementation.

## Repository model

```text
docs/
├── context/
├── product/
├── behavior/
├── architecture/
├── mechanism/
└── reference/
```

Each canonical JSON file is one node:

```json
{
  "$schema": "../../node_modules/product-lint/schema/canonical-node.schema.json",
  "schemaVersion": 1,
  "id": "behavior.approve-version",
  "level": "behavior",
  "statement": "A reviewer can approve the current version of a shot.",
  "constrainedBy": [
    "product.current-version",
    "product.approval-state"
  ],
  "sync": {
    "constraintsDigest": "sha256:product-lint-constraints-v1:..."
  }
}
```

Mechanism nodes alone bind knowledge to implementation:

```json
{
  "id": "mechanism.approval-command",
  "level": "mechanism",
  "statement": "Approval commands are implemented in the application layer.",
  "constrainedBy": ["architecture.approval-ownership"],
  "sync": {
    "constraintsDigest": "sha256:product-lint-constraints-v1:..."
  },
  "implementation": {
    "files": [
      "src/application/approve-version.ts",
      "test/integration/approve-version.test.ts"
    ],
    "digest": "sha256:product-lint-implementation-v1:..."
  }
}
```

The digests are machine-owned. Generate them from the staged Git index:

```bash
npx product-lint knowledge sync --staged
git add docs/
```

## Continuous lineage

Product Lint requires a direct parent from the immediately preceding level:

```text
Product      requires Context
Behavior     requires Product
Architecture requires Behavior
Mechanism    requires Architecture
```

A branch that stops early is structurally valid but incomplete. Frontier diagnostics tell an
agent what to ask or create next.

## Queries

What knowledge governs a file:

```bash
npx product-lint knowledge for-file src/application/approve-version.ts
npx product-lint knowledge for-file src/application/approve-version.ts --json
```

What changes downstream of a node:

```bash
npx product-lint knowledge affected-by product.current-version
```

Query-scoped text for an LLM:

```bash
npx product-lint llms for-file src/application/approve-version.ts
npx product-lint llms affected-by product.current-version
```

Product Lint traverses the source JSON on demand. It does not persist a generated full graph.

## Staged synchronization

With the hooks installed this happens automatically on commit. To run it by hand:

```bash
git add src/ test/
npx product-lint knowledge sync --staged
git add docs/
npx product-lint commit check --staged
```

The staged check enforces both directions:

```text
changed governed file -> changed Mechanism owner
semantic node change  -> every affected descendant staged
sync-only node change -> a real staged cause exists
```

It handles additions, modifications, deletions, and renames by comparing `HEAD` with the
Git index.

## Commit convention

Product Lint governs only the trailers and the body. **The subject line is yours.** It is
never parsed or constrained, so it composes with whatever convention your team already
uses:

```text
PROJ-4471 constrain approval to the current version

Approval must refer to the version the reviewer actually evaluated.

Knowledge-Change: product.current-version
Knowledge-Change: behavior.approve-version
```

Conventional Commits, a bare sentence, a ticket key, a release tag — all equally valid.

The trailer set must exactly match semantic canonical-node changes in the staged diff.
Synchronization-only changes do not receive trailers. A knowledge-changing commit also
requires a non-empty explanatory body.

If your team wants its own subject convention *enforced*, opt in with a regular
expression. It is unset by default:

```json
{
  "commit": {
    "subjectPattern": "^[A-Z]+-[0-9]+ "
  }
}
```

Non-matching subjects then fail with `PL2205 SUBJECT_PATTERN_MISMATCH`.

Validate a commit-message file:

```bash
npx product-lint commit message .git/COMMIT_EDITMSG
```

## Hooks

`product-lint init` installs this Lefthook configuration for you:

```yaml
pre-commit:
  piped: true
  commands:
    1_product-lint-sync:
      run: npx product-lint knowledge sync --staged && git add docs/
    2_product-lint-check:
      run: npx product-lint commit check --staged

commit-msg:
  commands:
    product-lint:
      run: npx product-lint commit message {1}
```

The sync command runs first and re-stages the digests it rewrites, so `git commit` works
without the manual sync-and-restage step. `piped: true` stops the check from running when
sync fails.

The pre-commit check allows an incomplete frontier so knowledge can be built incrementally.
Use the shipping check for terminal completeness:

```bash
npx product-lint ship
```

`ship` also requires a clean working tree.

## Diagnostics

Every diagnostic names the problem and the repair. An agent does not have to infer the
repair from the message:

```text
PL2202 MISSING_KNOWLEDGE_TRAILER Semantic node change is missing Knowledge-Change: product.current-version
  node: product.current-version
  fix: Add a trailer line for this node at the end of the commit message, in the form
       Knowledge-Change: <node-id>. Put one id per line, and leave a blank line before the
       first trailer.
```

Fields, when they apply:

```text
path       the file to edit
node       the node id involved
question   what to ask the user, for diagnostics an agent must not answer alone
expected   where the missing file belongs
fix        the specific repair
style      how to write, present when the fix asks for prose
run        the command to run
```

`--json` returns the same fields.

Context, Product, and Behavior state user intent, so their diagnostics carry
`action: ask-user` and `infer: false`. An agent must ask rather than invent. Architecture
and Mechanism follow from the code, so they carry `infer: true` and an agent may propose
an answer.

### Writing style

Diagnostics that ask for prose carry a `style` field requesting
[ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/): active voice, one
sentence, 25 words or fewer, no idiom. Statements stay easy to read, hard to misread, and
easy to search. `product-lint llms` output carries the same rule, because an agent that
reads a knowledge view usually goes on to edit a statement.

## Reference JSON

`docs/reference/*.json` stores non-canonical institutional memory. References do not
participate in downward propagation. Evidence can be anchored to an immutable commit:

```json
{
  "$schema": "../../node_modules/product-lint/schema/reference-node.schema.json",
  "schemaVersion": 1,
  "id": "reference.mistake-route-owned-transactions",
  "kind": "mistake",
  "statement": "Route-owned transactions previously allowed dependent writes to commit independently.",
  "relatedNodes": ["architecture.transaction-ownership"],
  "evidence": {
    "commit": "a3f19c2d8b7e4c1a9d0f6e2b5c8a1d3e9f7b6c4d",
    "files": [
      { "path": "src/routes/orders.ts", "lines": [84, 126] }
    ]
  }
}
```

Product Lint verifies the cited commit and paths when validating the working tree.

## Commands

```text
product-lint init [--force]
product-lint validate [--json]
product-lint check [--json]
product-lint frontier [--json]
product-lint ship [--json]
product-lint knowledge for-file <path> [--json]
product-lint knowledge affected-by <node-id> [--json]
product-lint knowledge sync --staged [--json]
product-lint commit check --staged [--json]
product-lint commit message <commit-message-file> [--json]
product-lint llms for-file <path>
product-lint llms affected-by <node-id>
```

## Scope

Version 0.1.0 intentionally does not include ADR files, plans, conventions, a persisted full
graph, semantic model calls, general `Built by` links, or tool-enforcement registries.
