# Product Lint

Product Lint is a deterministic guardrail for building product knowledge alongside code.
It stores canonical knowledge as a five-level JSON DAG:

```text
Context -> Product -> Behavior -> Architecture -> Mechanism -> repository files
```

Git stores history. Product Lint validates the current graph, detects the next missing
level, synchronizes staged implementation and knowledge changes, and enforces structured
commit trailers for semantic knowledge changes.

It does not use an LLM. Its diagnostics are designed so coding agents know when a decision
belongs to the user, and how to put that decision to them cheaply.

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

`init` will not edit a hook your Lefthook config already defines, because a duplicate
top-level key would shadow your own jobs. It prints the commands it skipped, and they are
not installed until you add them. Read what `init` prints; it reports what it did not do.

`product-lint check` exits with:

```text
0  valid and complete
1  invalid
2  structurally valid but incomplete
```

An empty repository therefore produces a machine-readable `MISSING_CONTEXT` diagnostic
rather than encouraging an agent to start from implementation.

## Adopting into a repository that already has code

Product Lint reads top-down, and an existing repository is the one case where the code
arrived first. `governedPaths.include` is the control.

Every changed governed file must resolve to a Mechanism node. A repository with a thousand
files and no knowledge therefore cannot commit anything inside `src/**` until the spine
reaches Mechanism — and the spine starts at Context, which only the user can answer.
`PL2106 UNGOVERNED_IMPLEMENTATION` names that, once, instead of demanding a Mechanism node
per file that `PL1104` would then reject.

So narrow the glob to the area you are modelling now:

```json
{
  "governedPaths": {
    "include": ["src/billing/**"]
  }
}
```

Build Context down to Mechanism for that area, widen the glob, repeat. The alternative —
governing everything on day one — makes a correct tree uncommittable, and what people learn
from that is `--no-verify`, which skips every other check in the hook as well.

`frontier` shows the size of the job inside the current glob:

```bash
npx product-lint frontier
```

While the graph has no Architecture level, every ungoverned file shares one cause and one
repair, so they arrive as a single `PL0602 UNGOVERNED_TREE` with the list rendered as a
tree:

```text
PL0602 UNGOVERNED_TREE 317 governed file(s) have no Mechanism owner, and no Mechanism node
can own them yet because the graph has no context level.
  files (317):
    (by directory, because the list is long)
    scripts/  19 files
    src/  298 files, 8 here
      components/  85 files, 77 here
      lib/  102 files, 14 here
        ai/  88 files, 8 here
      store/  43 files, 34 here
```

`N files, M here` separates the whole branch from what one Mechanism node in that directory
would have to own. Once an Architecture node exists, each file gets its own
`PL0601 UNMAPPED_FILE` again, because from then on the repair is per-file.

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
question   what the user needs to decide
expected   where the missing file belongs
fix        the specific repair
ask        how to put the question to the user, present when the fix needs their answer
style      how to write, present when the fix asks for prose
run        the command to run
```

`--json` returns the same fields.

Context, Product, and Behavior state user intent, so their diagnostics carry
`action: ask-user` and `infer: false`. Architecture and Mechanism follow from the code, so
they carry `infer: true` and an agent drafts them from the repository.

### Asking well

An open question is expensive to answer, and the user has often answered it already. So
the `ask` field does not say "ask the user". It tells the agent to search the repository
first, then to spend the user's attention in the cheapest form that fits:

```text
1. Draft to confirm    the repository already answers it; cite the source, ask to confirm
2. Candidates to choose  two or three readings are plausible; give each consequence, ask to pick
3. Decision brief      the options lead to different products; give the decision, the options,
                       the implications of each, your recommendation, and your reason,
                       and cite a precedent if one exists
```

Never ask an open question with no draft attached. Never record an answer the user did not
confirm.

### Writing style

Diagnostics that ask for prose carry a `style` field requesting
[ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/): active voice, one
sentence, 25 words or fewer, no idiom, and no noun used as a verb. Statements stay easy to
read, hard to misread, and easy to search. `product-lint llms` output carries the same
rule, because an agent that reads a knowledge view usually goes on to edit a statement.

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
product-lint help
```

`--help` works on any command, and prints usage instead of running it.

## Scope

Version 0.1.0 intentionally does not include ADR files, plans, conventions, a persisted full
graph, semantic model calls, general `Built by` links, or tool-enforcement registries.
