# Product Lint

Product Lint is a deterministic guardrail for building product knowledge alongside code.
It stores canonical knowledge as a six-level JSON DAG:

```text
Audience -> Context -> Product -> Behavior -> Architecture -> Mechanism -> repository files
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
```

`init` writes `product-lint.config.json`, creates `docs/` with a `.gitkeep` per level,
adds Product Lint's `pre-commit` and `commit-msg` commands to your Lefthook config
(creating it, or appending to an existing one), and installs the Git hooks. Running it
twice is safe.

It then runs `check` against what it just wrote, and exits with that result. Provisioning
is not an answer to "is this repository compliant", and on an adoption install the two
differ sharply: `init` creates empty level folders beside a `docs/` tree that may already
hold nodes, and those nodes have never been read. So `init` reads them, and a fresh
repository ends on `PL0011 MISSING_AUDIENCE` — the next thing to do — rather than on a list
of directories it made.

The output names the boundary between the two phases:

```text
created ./product-lint.config.json
created ./docs/audience
...

provisioning done. checking the working tree:

PL0011 MISSING_AUDIENCE No canonical audience nodes exist.
  question: Who is this product for? Name the sets that distinguish them, and the
            values in each set.
  ...
```

Because `init` carries `check`'s exit code, a successful install of an empty repository
exits **2**, not 0. That is the honest answer — the graph is incomplete — but a script
running `npx product-lint init` under `set -e` will stop there. Read the exit code as the
state of the graph, and the printed lines as the state of the install; the two are
reported separately on purpose.

`init` will not edit a hook your Lefthook config already defines, because a duplicate
top-level key would shadow your own jobs. It prints the commands it skipped, and they are
not installed until you add them. Read what `init` prints; it reports what it did not do.

`product-lint check` — and `product-lint init`, which ends by running it — exits with:

```text
0  valid and complete
1  invalid
2  structurally valid but incomplete
```

1 outranks 2: an invalid graph is not an incomplete one. Both commands read the working
tree through the same function, so `init` can never report a state its own `check`
contradicts.

An empty repository therefore produces a machine-readable `MISSING_AUDIENCE` diagnostic
rather than encouraging an agent to start from implementation.

## Adopting into a repository that already has code

Product Lint reads top-down, and an existing repository is the one case where the code
arrived first. `governedPaths.include` is the control.

Every changed governed file must resolve to a Mechanism node. A repository with a thousand
files and no knowledge therefore cannot commit anything inside `src/**` until the spine
reaches Mechanism — and the spine starts at Audience, which only the user can answer.
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

## The example used throughout

Every example below describes **one** product: a video review tool. Two audience sets
distinguish its users, and every query, slice, and diagnostic in this README is real output
from this graph.

```text
audience   role.reviewer   role.admin          <- what you do
           segment.freelance   segment.studio  <- who you do it for

context    review-state-lost          role.*                         every user
           delivery-audit-required    segment.studio                 studios, any role
           approval-authority-unclear role.admin + segment.studio    studio admins only
           no-dedicated-admin         segment.freelance              freelancers, any role

product    current-version         immutable-delivery-log
           single-approver         self-serve-setup

behavior   approve-version (current-version + single-approver)
           see-current-version     read-delivery-log     invite-teammate

architecture  approval-ownership   append-only-log       invite-flow

mechanism  approval-command   -> src/approval/**
           delivery-log-writer -> src/delivery/**
           invite-service      -> src/invite/**
```

Note `behavior.approve-version`. It has two parents from two different lineages, one of them
universal and one of them studio-admin only. That is the ordinary case, not a corner case,
and it is what makes the queries below worth running rather than guessing.

## Repository model

```text
docs/
├── audience/
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
  "statement": "A reviewer approves the current version of a shot.",
  "constrainedBy": [
    "product.current-version",
    "product.single-approver"
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
  "statement": "An application command performs approval.",
  "constrainedBy": ["architecture.approval-ownership"],
  "sync": {
    "constraintsDigest": "sha256:product-lint-constraints-v1:..."
  },
  "implementation": {
    "files": ["src/approval/**"],
    "digest": "sha256:product-lint-implementation-v1:..."
  }
}
```

The digests are machine-owned. Generate them from the staged Git index:

```bash
npx product-lint knowledge sync --staged
git add docs/
```

## Audience

The audience level is not one set of nodes. It is **n sets**, each a partition of the
people who use the product. The set a value belongs to is the second segment of its id:

```text
docs/audience/role-reviewer.json      audience.role.reviewer
docs/audience/role-admin.json         audience.role.admin
docs/audience/segment-freelance.json  audience.segment.freelance
docs/audience/segment-studio.json     audience.segment.studio
```

Each set is a partition on its own: you have exactly one role and exactly one segment. The
level as a whole is their product, which is why they are two sets and not one list — a flat
list containing `admin` and `studio` would not be mutually exclusive, because a person is
both.

A Context names a **selector** over those sets. Values within one set read as OR, and sets
read as AND:

```json
{
  "id": "context.approval-authority-unclear",
  "level": "context",
  "statement": "Studio administrators cannot tell who may approve a delivery.",
  "constrainedBy": ["audience.role.admin", "audience.segment.studio"]
}
```

That is studio admins, and only them. Two parents from two different sets mean *both* —
which no flat list of audiences can say, because a list of parents is a union. A freelance
admin and a studio reviewer each match one half and neither matches the whole, so neither
reaches this Context or anything below it.

A set the Context does not name is unconstrained, so scoping to one axis costs one parent
however many other axes exist:

```json
"constrainedBy": ["audience.segment.studio"]
```

That is every studio user, whatever their role — and it stays true when a third role is
added later.

To say "no set constrains this" and have it stay true, name the set itself:

```json
"constrainedBy": ["audience.role.*"]
```

**Use the wildcard rather than listing every value.** They mean the same thing today and
different things tomorrow. A Context that lists `role.reviewer` and `role.admin` names two
nodes, and neither of them changes when `role.producer` is created beside them — so the
digest does not move, `check` stays green, and the Context quietly stops covering everyone
while still claiming to. The wildcard is a parent whose fingerprint is the set's
*membership*, so adding a value makes every node scoped by it stale, exactly as editing a
statement would.

Below Context, audience is **derived** as the union of a node's parents and never declared.
So a node reaches everyone its parents reach, no node can claim a scope its ancestry does
not give it, and narrowing something means giving it a narrower Context — not annotating it.

## Continuous lineage

Product Lint requires a direct parent from the immediately preceding level:

```text
Context      requires Audience
Product      requires Context
Behavior     requires Product
Architecture requires Behavior
Mechanism    requires Architecture
```

A branch that stops early is structurally valid but incomplete. Frontier diagnostics tell an
agent what to ask or create next.

## Queries

Three questions, all answered against the graph above.

### What knowledge governs this file?

```bash
npx product-lint knowledge for-file src/delivery/log.ts
```

```text
audience: segment=studio
audience.segment.studio	The product serves teams inside a studio that delivers to clients.
context.delivery-audit-required	Clients require evidence that a studio approved a delivery.
product.immutable-delivery-log	The product records every delivery approval in an immutable log.
behavior.read-delivery-log	An administrator reads the approval history of a delivery.
architecture.append-only-log	An append-only store holds delivery approval records.
mechanism.delivery-log-writer	A writer appends delivery records to the store.
```

The `audience` line is the **resolved** answer, and it is not the same as reading the
lineage. Ask the same question about a file two lineages reach:

```bash
npx product-lint knowledge for-file src/approval/approve-version.ts
```

```text
audience: everyone
audience.role.admin	The product serves people who administer a team account.
audience.segment.studio	The product serves teams inside a studio that delivers to clients.
context.approval-authority-unclear	Studio administrators cannot tell who may approve a delivery.
context.review-state-lost	Reviewers lose track of which version they approved.
product.current-version	Each shot has one current version.
behavior.see-current-version	A reviewer sees which version of a shot is current.
product.single-approver	One named person approves each delivery.
behavior.approve-version	A reviewer approves the current version of a shot.
architecture.approval-ownership	The application layer owns approval transitions.
mechanism.approval-command	An application command performs approval.
```

The lineage lists `audience.role.admin` and `audience.segment.studio`, which reads as
"studio admins". The file serves **everyone**. Both are true: the file is reached through
the studio-admin Context *and* through `context.review-state-lost`, which names
`audience.role.*` — a set, not a node, so it appears in no lineage. That is exactly why the
resolved audience is printed rather than left to be inferred from the list.

### What changes downstream of this node?

```bash
npx product-lint knowledge affected-by product.current-version
```

```text
audience: everyone
node: product.current-version
node: behavior.see-current-version
node: behavior.approve-version
node: architecture.approval-ownership
node: mechanism.approval-command
file: src/approval/approve-version.ts
file: src/approval/state.ts
```

This is the blast radius of an edit: every node that must be re-read, and every file that
may have to change. `commit check` enforces the same set — a semantic edit to
`product.current-version` requires each of those descendants staged in the same commit.

### What does one audience need, and what may be mocked?

```bash
npx product-lint knowledge slice role=reviewer,segment=freelance
```

```text
keep: role=reviewer,segment=freelance
  kept   11 node(s), 3 file(s)
    real src/approval/approve-version.ts
    real src/approval/state.ts
    real src/invite/send.ts
  mocked 7 node(s), 1 file(s)
    mock src/delivery/log.ts
  contested 0 file(s)
```

```bash
npx product-lint knowledge slice role=admin,segment=studio
```

```text
keep: role=admin,segment=studio
  kept   13 node(s), 3 file(s)
    real src/approval/approve-version.ts
    real src/approval/state.ts
    real src/delivery/log.ts
  mocked 5 node(s), 1 file(s)
    mock src/invite/send.ts
  contested 0 file(s)
```

Both keep approval, because `context.review-state-lost` is universal. The freelancer keeps
invitations and mocks delivery logs; the studio admin does the reverse. Build one audience's
experience for real and stub the rest, then swap the selector and swap which half is real.

The mock set is the **complement of the keep closure**, never the closure of a mock root.
Those two differ whenever a node has more than one parent, which is most real graphs:
growing a mock set downward from "everyone else" stubs every node the kept audience happens
to share with them — on this graph that would wrongly stub both approval files for both
audiences. `contested` names that difference, and is `0` here precisely because the slice
subtracts rather than grows.

### The same views, written for an agent

```bash
npx product-lint llms for-file src/delivery/log.ts
npx product-lint llms affected-by product.current-version
```

```text
# Product knowledge for file
file: src/delivery/log.ts
audience: segment=studio

## audience.segment.studio
level: audience
statement: The product serves teams inside a studio that delivers to clients.

## context.delivery-audit-required
level: context
statement: Clients require evidence that a studio approved a delivery.
constrainedBy: audience.segment.studio
...
```

The `llms` views carry the full statement of every node, plus the style, shape, placement,
and vocabulary rules, because an agent that reads one usually goes on to edit a statement. A slice is a
lineage, so it hides the level the shape rule is about — and shows the parent the placement
rule is about.

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

## Removing and renaming knowledge

A node can leave the graph legitimately, and the two ways it happens look identical in a
diff. A **rename** restates a claim under a new id; a **removal** withdraws it. Both are
deletions, and a deletion that dangles no edge — a leaf, which is what most Mechanism
nodes are — once left no record but a `Knowledge-Change:` line indistinguishable from an
edit's. Deletions carry their own record instead:

```text
Knowledge-Removed: product.a-completion-can-be-taken-back
Knowledge-Renamed: product.the-old-claim -> product.the-claim-restated
```

A `Knowledge-Renamed` line records one event — the deletion of its source and the addition
of its target — so the target owes no separate `Knowledge-Change` line. Every deleted id
must be declared exactly once, as removed or as a renamed source; `PL2207`–`PL2210` enforce
the bookkeeping against the staged diff. A deletion already required a trailer, so this
changes the shape of the record, not its price: the removal block of a commit is exactly as
long as the destruction is wide, and `git log --grep='^Knowledge-Removed:'` is a standing
audit of everything the graph ever gave up. Many renamed sources may share one target —
a merge, recorded as such. Both trailer names are configurable, like `commit.trailer`.

The staged check classifies each deletion before the message exists, and the
classification is a reading, never a gate. A deleted id whose claim reappears — statement
similarity at PL0802's threshold, or an identical parent set plus a shared content word,
because a real rename usually rewrites the statement and keeps its placement — is
`PL2109 NODE_RENAMED`, carrying the suggested trailer line. Textual evidence reads as a
note; placement-only evidence reads as a question, because the two mistakes are not the
same size — a false removal adds a line, a false rename suppresses the warning below and
the loss goes silent. A deleted id nothing replaces is:

```text
PL2108 NODE_REMOVED mechanism.approval-command is deleted, and nothing staged replaces it.
  path: docs/mechanism/approval-command.json
  node: mechanism.approval-command
  question: Withdraw this claim? "Approval is implemented by an application command." Under
            architecture.approval-owner, 0 other mechanism node(s) remain.
  fix: If the removal is intended, declare it: add "Knowledge-Removed: <node-id>" to the
       trailer block and say why in the body. If it is not, restore the node: git restore
       --staged --worktree --source=HEAD -- <path>.
  ask: A removal destroys a claim someone approved, so it is confirmed, never inferred. Show
       the owner the statement and what its parent keeps, and record only what they confirm:
       removed on purpose, or restored.
```

A warning, not an error — if removing a node becomes a fight, pruning stops and the graph
rots. The question carries the destroyed statement verbatim because the reader must see
what is being destroyed without checking out a file that no longer exists.

`PL2110 COVERAGE_NARROWED` names the third event: a child that leaves its parent while
staying in the graph — the re-parent that quietly abandons a problem. It compares edge
identity, not child counts, because a sweep replaces what it deletes and the count holds
still; both edge ends follow their rename successors, so a pure rename never fires. A
deleted child is `PL2108`'s event, and the two never double-fire.

None of this reaches a node with children: deleting a parent dangles its children's
`constrainedBy` and dies in validation (`PL1102`), so the checks are scoped to leaves by
subtraction, not by a test.

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
vocabulary how terms are marked, coined, and placed, present when the fix writes prose
run        the command to run
```

`--json` returns the same fields.

Audience, Context, Product, and Behavior state user intent, so their diagnostics carry
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

The `style` field also carries the one-thing rule: a statement says one thing, and a sentence
joining two claims that can be false independently is two nodes. A node that states two things
cannot be superseded by halves — changing one claim forces the other to be restated with it,
and every descendant to be resynchronized for a change that did not reach them.

### Shaping the level

Diagnostics that are about to add a node carry a `shape` field. Where `style` governs one
sentence, `shape` governs the set:

```text
Keep each level a set of small nodes that do not overlap and that cover the level.
One node states one thing. Prefer more small nodes over fewer large ones.
Before you add a node, read the nodes already at that level.
If one of them already states this, do not write a second node. Add your parent to its
constrainedBy list instead — a node is allowed many parents, and two sources that agree
are one node with two parents.
```

The two rules are kept apart on purpose. The style rule is checkable by reading one statement.
The shape rule is not checkable that way at all — two overlapping nodes each read correct in
isolation, and only the level shows the overlap. Merging them into one field would make both
vaguer.

This is why the rule is delivered *before* the node is written rather than enforced after.
Mutual exclusivity between two prose statements has no deterministic test, and a guess that
blocks a commit is worse than a rule that instructs. `product-lint llms` carries `shape` as
well as `style`, for a sharper reason than convenience: that view is a *slice*, showing a
lineage and never a level, which is the exact position from which a duplicate sibling gets
written.

One part of the rule *is* decidable and is enforced rather than instructed. Only Mechanism nodes
bind to files, so at that level the repository settles the question — see `PL0603` below. Above
it the rule stays an instruction, because nothing there can be checked without judging what two
sentences mean.

The audience level carries a different `shape` rule, because it is the one level that is not a
single set. Telling an agent to "keep the level a set of nodes that do not overlap" would have it
write one node per combination — `admin-studio`, `admin-freelance`, and so on — which is the
shape sets exist to avoid. And the general rule's repair for a duplicate is "add your parent to
its constrainedBy instead", which cannot apply to a node that has no parents. So `PL0011` carries
its own rule: n sets, each a partition, and a conjunction written as two parents rather than as a
combined node.

### Placing the node

The same diagnostics carry a `placement` field. It is the third rule and the third scope:
`style` is checked by reading one sentence, `shape` by reading the level, `placement` by
reading a node beside its parent.

```text
A level is decided by what would make the statement false, not by what the statement is about.
Name the smallest change that would force you to rewrite the sentence, then find that change below.
audience: a kind of person appears, or two values become one.
context: users stop having the problem. A context statement stays true even if you build nothing.
product: you decide to promise something else. Name no surface here.
behavior: someone uses the product and sees something else. Name the actor and the occasion.
architecture: a responsibility moves across a boundary and the output does not change.
mechanism: the code changes and the ownership model does not.
Write the node at the shallowest level whose change would falsify it.
```

Placement is decided by what would *falsify* a statement, never by what the statement is about.
Every level talks about the same product, so a subject matter test leaks at every boundary. The
falsifier does not, because each level owns exactly one class of change — and a sentence with
two falsifiers is not an ambiguous node, it is two nodes, which is the one-thing rule read down
the graph instead of across a sentence.

Neither of the other rules can catch what this one catches. A node that is well written, that
overlaps no sibling, and that sits one level too deep reads correct all three times it is looked
at. The rule ends with the pair check that finds it: **the child must be able to be false while
the parent stays true.** If it cannot, the child restates its parent, and the level below it has
nothing to constrain.

Product and Behavior are the boundary that actually gets confused, because both are `ask-user`,
both are about the user, and neither names a file. The `placement` rule separates them by the
occasion: a Product rule holds everywhere and a Behavior happens somewhere. This is also why the
Behavior question asks *when* — "what must a user, client, or system observe or do, and on what
occasion". Asking what someone "should be able to" do is answerable by restating the Product rule
with a modal in front of it, which fills the level without adding a claim.

`PL0011` carries no `placement` rule, for the reason it carries its own `shape` rule: the pair
check compares a node with its parent, and an Audience node has none.

Like `shape`, this rule is delivered before the node is written rather than enforced after.
`PL1104` can see that a parent exists one level up; nothing can see that the statement belongs
there.

## Vocabulary

As knowledge descends the levels it coins vocabulary — the product's own nouns. Left
implicit, the coining is invisible: a term gets introduced inside a statement with no
declaration, and nothing can tell a defined noun from ordinary English, so one word
quietly carries two meanings while two words quietly name one thing.

A **term** is declared where it is first needed, inside the level that needs it:

```json
// docs/product/terms/plan.json
{
  "$schema": "../../../node_modules/product-lint/schema/term-node.schema.json",
  "schemaVersion": 1,
  "id": "term.plan",
  "level": "product",
  "name": "plan",
  "definition": "A plan is the set of doable tasks a member approves to resolve one ambiguous task.",
  "borrowed": "Schedule, from scheduling theory. Ours is approved rather than computed, and it resolves one task rather than sequencing many.",
  "rejected": [
    { "name": "schedule", "stance": "wrong", "because": "Names the times, not the set of tasks." },
    { "name": "list", "stance": "taken", "because": "Already load-bearing for anything a member collects." }
  ]
}
```

A term is a name, not a claim: it has no `constrainedBy` and creates no frontier
obligation. Its only edges are its **uses**, marked in the prose itself:

```text
Only a *plan* the member approves finishes the work of making a task doable.
```

So a reader — and the linter — can tell the defined noun from "we plan to ship". The
statements' other notations keep their jobs: backticks are code identifiers, quotes are
surface literals, asterisks are defined terms.

The decidable half is enforced. A marked word must resolve (`PL1307 MISSING_TERM` —
marking nothing is legal; the moment you mark, you owe the declaration). One name has one
declaration, globally (`PL1304 DUPLICATE_TERM_NAME` — one word cannot carry two meanings;
the repair is a two-word rename: *day plan*, *retain plan*). And vocabulary flows down
only (`PL1308 TERM_FROM_BELOW`): a statement may use terms of its own level and above,
never below, so a product law written in a surface's or a mechanism's word is named.

`PL1312 REJECTED_TERM_NAME` refuses a name another term rejected as `wrong`. What it
asserts is not "this is a duplicate" — nothing can tell a duplicate wearing the rejected
name from a real second sense — but that a recorded decision is being contradicted without
saying so. The repair is `PL1304`'s repair: a two-word name saying which sense this one
carries, which produces the better name anyway. Deleting the rejection is the other route,
and it is right only when you actually changed your mind, in which case the deleted line is
the record of the reversal. The check is global and case-insensitive on the whole name,
matching `PL1304` exactly, because marks resolve globally — a reader of any statement
resolves `*plan*` without knowing what level they are on, so a level-scoped rejection would
be incoherent with the notation. It runs as a second pass over the loaded terms, so the
finding never depends on which file was read first.

Neither `borrowed` nor `rejected` joins `semanticTermFingerprint`. Discovering that your
word matches an established one does not change what any statement means, and neither does
writing down a name you passed on, so neither restates the statements that speak the word:
both changes classify as synchronization-only. Editing the `definition` to match a borrowed
sense *does* change meaning, and that still propagates. Without this line, attaching origins
to an existing vocabulary would restate the whole graph for no change in meaning — and
would simply not get done.

### Where a word came from, and what it beat

Most product nouns are not coinages. The thing already has a name in information retrieval,
in records management, in scheduling theory — and a borrowed name is legible to anyone who
knows the field and looked up by anyone who does not. `borrowed` is one sentence saying
where the word comes from and how this graph's sense departs from it. The bar is not an
exact match: a term fits when the idea lands most of the way, and the departure sentence is
where you say what you changed. Naming the failure state of an established metric is not
inventing terminology as long as the node says so.

It is one free string on purpose. Nothing queries it — it exists to be read in `frontier`
and the `llms` views before a statement is written — and an object with a `source` slot
would invite completing the set, which is how a fluent wrong citation gets written.

`rejected` is the names you weighed and passed on, with the reason. A naming decision
otherwise leaves no trace: you consider three words, pick one, and the only evidence is
that a different word is present. Nobody can then tell a name chosen over alternatives from
the first word that came to mind. The field is **required**, and `[]` is the honest answer
when nothing was weighed — absent and empty would otherwise be one byte with two meanings,
and "nobody wrote it down" reading as "nothing was considered" is what makes an unrecorded
term useless rather than merely incomplete. Write the losers down while you are choosing:
a statement can be reconstructed from the problem and the code, and a discarded word cannot
be reconstructed from anything.

Each rejection carries a `stance`, because two rejections are different facts:

- **`wrong`** — the word does not name this thing. Guarded: `PL1312` refuses the name to
  another declaration, and `PL0806` reports it appearing in prose.
- **`taken`** — the word already names something else here. Recorded, never enforced.

Rejecting a name because it is spoken for is a common and correct move, and it predicts
that the word goes on being used — and eventually declared — for that other thing. Guarding
it would fire on exactly the case it was written to describe, and the only clean repair
would be deleting a true record. `PL1304` still catches any real collision with a name.

Every level may declare, audience and context included. A term's level is decided the way
a node's is — by what would falsify it — so a name for something in the member's world is
declared at context and stays true if you build nothing, while a name for something the
product promises is declared at product. Declaring wider does not speak wider: `PL1308` is
unchanged, so a context statement still cannot mark a product term, and a term declared
where no statement of that level marks it is `PL0805`, a report rather than a refusal.

Definitions join the digest machinery. A node whose statement marks terms carries
`sync.vocabularyDigest`; changing a definition goes stale everywhere the word is spoken
(`PL2004 STALE_VOCABULARY`), and the commit path requires every marking text staged beside
the definition change, with a `Knowledge-Change: term.plan` trailer. Nodes that mark
nothing carry nothing, so adopting costs zero bytes in existing files.

The judgement half is reported, never enforced:

```bash
npx product-lint vocabulary            # the review surface, exit 0 always
npx product-lint vocabulary --staged   # scoped to the staged diff
```

`PL0801 UNMARKED_TERM_USE` finds a declared name used unmarked at the term's level or
deeper — never shallower, never verb forms, never inside quotes — grouped one block per
term so a common word folds instead of flooding. The scan carries no dictionary: zero
declared terms, zero noise, which is what keeps an undeclared term legal forever.
`PL0802 SYNONYM_CANDIDATE` reports two definitions written in mostly the same words, and a
human decides — two words *may* name two things. `PL0803 CAPITALIZED_UNDECLARED` is the
migration seed: mid-sentence capitals are the convention statements were already
half-using for product nouns. `PL0806 REJECTED_NAME_IN_PROSE` is `PL0801`'s scan pointed at
the losers instead of the winner: a name rejected as `wrong`, written unmarked in a
statement at the term's level or deeper. It catches the drift the rejection was recorded to
prevent — you decide a word does not name the thing, then reach for it six months later.
`commit check --staged` additionally prints `PL0801` and `PL0806` for the statements in the
diff, info only — the one moment the mark costs two characters in a file already open.

The fourth authoring rule travels with the same diagnostics that carry the other three,
and the frontier prints the **terms in scope** beside the nodes already at the level, for
the same reason: synonym prevention happens before the write. The `llms` views carry a
`# Terms` section with the definition of every term the shown statements mark, so an agent
meets *plan* with its meaning on the page it is editing from.

`knowledge affected-by term.plan` lists the blast radius of a definition change or a
rename: every statement and definition that speaks the word.

A required `rejected` reaches one moment, the term's creation, and alternatives are usually
weighed later — while writing a statement, about a term declared months ago and not open.
Recording one then costs finding the file and matching an array shape, which is more than
the decision cost, so it does not happen:

```bash
npx product-lint term reject term.rung cadence --wrong --because "Names the tempo, not the slot."
```

Exactly one stance, never a default: which one it is decides whether the name is guarded or
merely recorded, and guessing for the author would put a guard on a word they said was
spoken for. A reason is required for the same reason the schema requires it. The write is
refused with the diagnostic it would have caused — rejecting a name that is already declared
as `wrong` reports `PL1312` before the file changes, and says that `--taken` is the stance
that fits. There is no `term add`: the required field and the load diagnostics already name
every mistake a scaffold would prevent.

## Scope: the problems being built right now

A graph is otherwise all-or-nothing. Every node owes a descendant at the next level and
every governed file owes a Mechanism owner, so a repository with nine problems owes nine
subtrees before `check` goes quiet. `scope` says which of them are being built:

```json
"scope": {
  "roots": ["context.coherence", "context.decision-locality"],
  "because": "Shipping the retrieval problems first; the rest are recorded, not being built."
}
```

`because` is required — deferring seven problems is a product decision, and `loadConfig`
refuses a scope without its reason the way it refuses invalid JSON. Absent `scope` means the
whole forest, which is the default.

**Scope silences obligations, never invariants.** A deferred problem stops demanding the
levels below it. It does not stop being valid JSON, having a parent, carrying a current
digest, or resolving the words it marks — a malformed file breaks the whole graph regardless
of what is being shipped.

In scope means the roots, everything below them, and everything above them. The deferred set
is the **complement** of that closure, never the closure of the other roots: those differ
wherever a node has more than one parent, and growing the deferred set downward would defer
every node the kept problems happen to share. That difference is reported as a count — the
deferred problems are already partly built, which is worth knowing before deciding they are
deferred.

`PL1401 UNKNOWN_SCOPE_ROOT` is an error, because a typo in one id would scope the graph to
nothing reachable and the whole report would go quiet, which reads exactly like a clean
repository. `--all` widens for one run; it needs no recorded reason because it reveals rather
than silences.

```
scope: 2 of 9 problems
  context.coherence
  context.decision-locality
  because: Shipping the retrieval problems first; the rest are recorded, not being built.

...

deferred: 7 problem(s), 41 obligation(s), 6 node(s) already shared with them
  product-lint check --all
```

## Adopting a codebase that already exists

`PL2101 UNMAPPED_STAGED_FILE` refuses an edit to a file no Mechanism owns, and the repair is
a Mechanism, which needs an Architecture parent, which needs a Behavior parent, up to a
problem that may not exist. On a repository adopting Product Lint with code already in it,
that is a wall on the first edit.

```bash
npx product-lint adopt src/billing/retry.ts   # the file you tripped over
npx product-lint adopt --all                  # every governed file with no owner
```

`adopt` writes a **draft spine** instead: one placeholder node per level, each constrained by
the one above, the Mechanism binding the module's files. The logistics are satisfied at once
— every file has an owner, every node has a parent — so the commit passes, and what is
missing is exactly one thing per node: a sentence.

Clusters are modules, the first directory beneath a governed root. One spine per file would
be six placeholders each and a mid-sized repository would gain thousands; one spine for the
whole tree is a single trunk, and the point of drafting bottom-up is to **see what problems
the code already implies** — a graph with one problem in it says nothing to revise. The
audience placeholder is shared across every cluster, because a codebase does not gain an
audience per directory.

Every node it writes carries `"draft": true`. That is not a hole in the graph: a placeholder
the tool reads as exactly what it is announces itself, where an unowned file says nothing
about what it belongs to. It is a counted, listed, gated debt.

`PL0901 DRAFT_NODE` lists them grouped by level, shallowest first, because that is the order
of leverage — a context statement decides what everything under it is even for. **`ship`
refuses while any draft remains**, not because a draft is invisible but because of what
`ship` means: terminal completeness, and file bindings under statements nobody has made are
not that. `check` and `commit check` pass.

`PL0902 DRAFT_LOOKS_WRITTEN` catches the one hole a flag opens that a marker string does not:
a node whose statement is no longer the generated one has been written, and only the flag was
left behind. Without it, `ship` would stay red forever for finished work.

## Which surface says what

Five surfaces, layered by **what you do next with the output** rather than by how much they
report. Each one answers a different question, and each names the next one down.

| surface | the question it answers | output |
|---|---|---|
| `commit check` — refusal | why am I stopped? | errors, grouped by cause |
| `commit check` — brief | what is next? | 3 rows |
| `check` | where does the whole graph stand? | ~10 rows |
| `check --full` | what are all the repairs? | every finding, with its block |
| `frontier` | write me the next node | one work order |
| `diff [<ref>]` | what did this branch change about the product? | claims added, withdrawn, restated |

The layering matters most at the bottom. **`frontier` is not a report, it is a work order**:
it carries the node template, the level's authority question, the sibling nodes to read
before writing a duplicate, the terms in scope, and the statement, shape, placement, and
vocabulary rules. That is around forty lines *per node*, because it is meant to be handed to
whoever writes the node next.

So it hands over **one** by default — the shallowest-level obligation, ties broken on the id
so two runs agree — and says how many are waiting. Seven at forty lines each is the same wall
the summary exists to prevent, one level down.

```bash
product-lint frontier                  # the next node to write, in full
product-lint frontier product.core-0   # the work order for a specific one
product-lint frontier --full           # every obligation
```

And the surfaces above it route into it: a summary row that names a *missing* node is not a
repair to read, it is a node to write, so `check` and the commit brief print
`product-lint frontier` whenever any finding is a frontier obligation. Without that line the
summary tells you what is wrong and strands you there.

## The summary

`check` and `ship` print a summary by default. `--full` gives every finding with its repair.

```text
10 finding(s) — errors first, then shallowest level, the order of leverage

    context   imbalance           1 context.core
    product   missing-product     1 context.edge-b
    behavior  missing-behavior    7 product.core-0
    behavior  ungoverned-tree     1 src/x.ts

  scope: 1 of 3 problems — 4 finding(s) deferred, 1 shared with them
  because: Shipping the core problem first.
  ignored: thin on context.edge-a — One law is genuinely enough.

  product-lint check --full     every finding with its repair
  product-lint check --all      include the deferred problems
```

The full blocks are right, and they are the wrong thing to open with. One `PL0201` prints
its question, its fix, the four asking formats, the statement style, the shape rule, the
vocabulary rule, and twenty sibling nodes — so on a real repository the first fifteen lines
of `check` were one finding's remediation prose and nothing else. A reader heads the output
anyway; the first fifteen lines have to be the whole picture.

Ordering is **severity, then level**. Severity first because an invalid graph is not an
incomplete one, and shape findings read off a graph that does not parse are noise — the same
rank `applyStatusExitCode` already uses for exit codes. Level second because a problem
decides what everything beneath it is even for, so the same finding is worth more the
shallower it sits. A finding about the repository rather than a layer sorts after the layers
instead of pretending to be the shallowest.

Rows fold by code and level, and `PL0901` expands per level rather than folding — sixteen
drafts are not one job, they are a context job and then a product job. Everything held back
is named: the rows beyond the limit, what scope deferred, and every ignore that was honoured.

`frontier` is never summarized. Its whole job is to hand over the next node to write with the
template, the question, and the siblings to read first, and a one-line row would delete
exactly what it exists to deliver.

### The commit seam

`commit check --staged` has two messages, and they never blend. A refusal carries nothing
but the refusal — a list of unrelated opportunities beside it buries the one thing that has
to be read. A pass carries what to do next, because the commit is the one moment the tool is
certain to be read, and spending it on silence is how a repository drifts.

**Refusals rank by cause, not by level.** Every entry is an error, so severity cannot sort
them, and the level a node sits at says nothing about what to fix first. What ranks them is
what fixing one makes knowable: a file that does not parse contributes no node, so the graph
built without it is missing parents that exist on disk; a graph that does not build has no
lineage, so every digest over it is meaningless. Groups below a broken group are not "also
wrong" — they are unknown, and several routinely vanish when the one above is repaired.

```text
commit blocked — 8 errors in 5 groups, first cause first

  1. the files do not parse   2 errors
     ! product.one  missing-statement, unknown-node-field

  2. the graph does not build   1 error
     ! product.one  missing-constraint-node

  3. words do not resolve   1 error
     ! behavior.x  missing-term

  4. derived data is stale   3 errors
     run: product-lint knowledge sync --staged   (repairs all 3)

  5. this commit is inconsistent with itself   1 error
     ! mechanism.owner  stale-staged-mechanism

  Fix group 1 first: the groups under it are computed from what it breaks, and some will
  not survive the repair.
  context:
    product-lint llms affected-by product.one
    product-lint llms affected-by behavior.x
```

Inside a group there are two collapses, and the shape decides which applies. Many subjects
sharing one repair become **one line** — twelve stale nodes and one `knowledge sync` is a
single instruction printed twelve times. One subject with several faults becomes **one line
naming all of them**, because they are fixed in one edit and splitting them across rows makes
one job look like three. Subjects sort by how broken they are, so the file worth opening is
first, and the context commands follow the group order rather than the input order.

A passing commit gets the brief — three rows, because it fires on *every* commit and a
fifteen-line wall is read for a week and skipped forever after:

```text
next, highest leverage first:

  context   imbalance           1 context.core
  product   missing-product     1 context.edge-b
  behavior  missing-behavior    7 product.core-0

  1 more · 4 deferred by scope (Shipping billing first.) · 2 ignored (thin on context.a, +1)
  product-lint check
```

It reads the **staged** tree, because that is the state the commit is about to create rather
than whatever happens to be on disk beside it. `--full` restores the flat blocks.

## Product smells

Every check above is **local**. `PL0201` asks whether this node has a child at Behavior;
`PL1104` asks whether this node's parent exists. None of them look at the distribution, so a
graph can pass `ship` with exit 0 and still be a mess — and the mess is legible, because the
ways a DAG forest can be badly shaped have names and several map onto product problems.

```bash
npx product-lint smells            # exit 0 always, like vocabulary
npx product-lint smells --all      # ignore scope.roots for this run
```

```text
PL0910 IMBALANCE context.core holds 6 of 7 product node(s), and 2 sibling(s) share the rest.
  when fine: A product can have one core problem and several adjacent ones, and then this is
             the true shape. The question is whether the dominant node is one thing or several
             wearing one name — and whether the thin siblings are underbuilt or do not belong.
```

**Every finding says what would make the shape correct.** These are all "usually fine,
sometimes a tell", so `whenFine` is a required field on a finding rather than a convention —
a report that only accuses teaches its reader to skip it.

Two rules belong to the harness rather than to any one smell, because getting either wrong
once would poison every smell that ever lands:

- **Draft nodes are invisible.** A freshly adopted repository is N identical
  `1→1→1→1→1→1` chains, which is a degenerate forest. Every distribution metric would fire
  on scaffolding, and the report would be useless at exactly the moment someone first reads
  it. `smells` says how many nodes it skipped for this reason.
- **Out-of-scope nodes are invisible, and counted.** Same contract as everywhere else.

Thresholds are **fixed and versioned**, never configurable, on the same standard as
`STOPWORDS`: a threshold a reader can tune is a threshold that gets tuned until the report is
empty, which is a suppression list wearing a number. What you can do is turn a smell off,
with its reason:

```json
"smells": {
  "ignore": [
    { "smell": "imbalance", "node": "context.core",
      "because": "One problem is the product; the other two are adjacent surfaces." }
  ]
}
```

`because` is required, `node` is optional and narrows the silence to one node, and the
report prints every ignore it honoured. `PL1402 UNKNOWN_SMELL` is an error, because an
ignore naming a smell this version does not detect silences nothing, quietly.

There is deliberately no predicate language over graph properties. That is an engine to
maintain, and the cases it could not express are exactly the ones where the smell is telling
the truth.

Adding the next smell is one entry in `SMELLS` and one `detect()` — the harness already owns
the two rules, the ordering (shallowest level first, because that is the order of leverage),
the ignore handling, and the rendering.

## What a change did to the product

```bash
npx product-lint diff              # against HEAD: what have I changed?
npx product-lint diff main         # the review question, for a branch
```

`git diff` answers a different question and cannot answer this one. A rename plus a rewrite
is two file changes and one claim restated. A digest churn across forty descendants is forty
file changes and no claim at all. `diff` reports **claims** — added, withdrawn, restated —
shallowest level first, with the before and after text.

It reuses `classifyNodeChanges` and `classifyDeletions` rather than reimplementing them, so
the diff and the commit path can never disagree about what counts as a claim changing, or
about whether a removal-plus-addition was one claim renamed. A term redefinition is called
out separately and says that it reaches every use, because that is never a small change
however small the edit looked.

When either side does not build, it says so rather than showing the arithmetic. A graph with
no nodes makes every node on the other side read as added or withdrawn — a rename that forgot
to re-parent its children reported the entire product as deleted.

## Standing mistakes

`docs/reference/*.json` with `kind: "mistake"` is the one place this tool records that a claim
was **wrong**. Everything else it checks is missing, stale, or badly shaped — facts about
form. Nothing says a statement is false, and nothing can, because that is a judgement.

`PL0920 STANDING_MISTAKE` reports a mistake while the node it names has **not changed since
the commit that recorded it**. A claim someone revised after learning it was wrong has been
answered, and repeating it forever would train a reader to skip the one report carrying
hard-won knowledge. Like every judgement finding it says when the shape is fine: the mistake
may have been about the implementation rather than the claim, and recording that is a
one-line edit to the reference.

Until this existed, references were read by `knowledge for-file` and `affected-by` and by
nothing else — so the most expensive knowledge in the repository, the kind you only get by
being wrong, was the least likely to be seen again.

## Overlapping mechanisms

Only Mechanism nodes bind to files, so Mechanism is the one level where "these two nodes overlap"
has an answer the repository can give:

```text
PL0603 OVERLAPPING_MECHANISM mechanism.approval-command claims every file
mechanism.approval-state claims. A governed file has one Mechanism owner.
  files (1):
    src/approval/state.ts
  fix: Decide which Mechanism owns the shared files and narrow the other node's
       implementation.files so each governed file has exactly one owner. If neither node owns
       them alone because the two say the same thing, delete one and give the survivor both
       parents — a node is allowed many parents.
```

This is an error, not a question, on the same standard as `PL0502`: a claim the repository
disproves. Two globs that *could* both match are not enough — the snapshot must actually hold a
file they both match, or there is no evidence.

## Reference JSON

`docs/reference/*.json` stores non-canonical institutional memory. References do not
participate in downward propagation. Evidence can be anchored to an immutable commit:

```json
{
  "$schema": "../../node_modules/product-lint/schema/reference-node.schema.json",
  "schemaVersion": 1,
  "id": "reference.mistake-approval-lost-on-reupload",
  "kind": "mistake",
  "statement": "Re-uploading a shot previously cleared an approval without telling the reviewer.",
  "relatedNodes": ["architecture.approval-ownership"],
  "evidence": {
    "commit": "a3f19c2d8b7e4c1a9d0f6e2b5c8a1d3e9f7b6c4d",
    "files": [
      { "path": "src/approval/state.ts", "lines": [84, 126] }
    ]
  }
}
```

Product Lint verifies the cited commit and paths when validating the working tree.

## Commands

```text
product-lint init [--force]
product-lint validate [--json]
product-lint check [--all] [--full] [--json]
product-lint frontier [--all] [--json]
product-lint ship [--all] [--full] [--json]
product-lint adopt <path>... | --all [--json]
product-lint diff [<ref>] [--json]
product-lint smells [--all] [--json]
product-lint vocabulary [--staged] [--json]
product-lint term reject <term-id> <name> --wrong|--taken --because <reason> [--json]
product-lint knowledge for-file <path> [--json]
product-lint knowledge affected-by <node-id|term-id> [--json]
product-lint knowledge slice <set=value,...> [--json]
product-lint knowledge sync --staged [--json]
product-lint commit check --staged [--json]
product-lint commit message <commit-message-file> [--json]
product-lint llms for-file <path>
product-lint llms affected-by <node-id>
product-lint help
```

`--help` works on any command, and prints usage instead of running it.

## Scope

Product Lint intentionally does not include ADR files, plans, conventions, a persisted full
graph, semantic model calls, general `Built by` links, or tool-enforcement registries.

Vocabulary support keeps the same lines: no semantic judgement in the lint path (synonymy
beyond exact-name collision is reported for a human, never blocked), no aliases or synonym
rings (two names for one thing is the defect, not a feature), no suppression lists, no
governance of prose outside canonical nodes, and no persisted glossary — the `vocabulary`
command is a view, like every other.

`rejected` looks like it crosses two of those lines and crosses neither. A synonym ring
makes two names resolve to one term; a rejected name resolves to **nothing**, which is the
point of writing it down. A suppression list silences a diagnostic; `rejected` creates two.
The one place the analogy holds is `stance: "taken"`, which does buy silence — and it is
written by the same person the diagnostic serves, so mislabelling a rejection only costs
them the guard they wanted. Same trust model as `contested`.

There is also no candidate list, no palette, and no home for vocabulary a statement has not
used yet. A term node requires a level, an unused word has no statement and therefore no
falsifier to decide one, and a guessed level is a commitment made before the evidence
exists — `PL1308` if the guess is too deep, `PL0805` forever if it is too shallow. Seventy
unplaced words would also take the twenty slots `frontier` prints, burying the terms
actually in play under the terms nobody uses. A palette belongs in prose, where browsing it
is the point; the graph holds words that statements speak.

`adopt` writes nodes, which looks like it crosses the "no semantic model calls" line and does
not. What it derives from the repository is the *file bindings* — the same category as
`knowledge sync`, which already writes derived data. Every sentence is left to a person, and
`draft` is the node saying so out loud.

`scope` looks like a suppression list and is not. It silences obligations rather than
diagnostics, carries a required reason, states its own count in every report it quiets, and
`--all` reverses it with one flag that needs no justification.
