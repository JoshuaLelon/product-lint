#!/usr/bin/env node
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Diagnostic, KnowledgeGraph, ResolvedConfig, ScopeSummary } from "./types.js";
import { renderSummary } from "./summary.js";
import { loadConfig } from "./config.js";
import { formatDiagnostics, hasErrors } from "./diagnostics.js";
import { annotateDiagnostics } from "./remediation.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { inspectWorkingTree } from "./status.js";
import { knowledgeForFile, affectedByNode, sliceForAudience } from "./queries.js";
import { renderAffectedKnowledgeForLlm, renderFileKnowledgeForLlm } from "./llms.js";
import { synchronizeStaged } from "./sync.js";
import { checkCommitMessage, checkStagedCommit } from "./commit.js";
import { initProject } from "./init.js";
import { isWorkingTreeDirty, stagedChanges } from "./git.js";
import { affectedByTerm, vocabularyReport } from "./vocabulary.js";
import { loadTermNodes, recordRejection, serializeTermNode } from "./terms.js";
import { adopt } from "./adopt.js";
import { KNOWLEDGE_LEVELS } from "./types.js";

function usage(): string {
  return `Product Lint

Usage:
  product-lint init [--force]
  product-lint validate [--json]
  product-lint check [--all] [--full] [--json]
  product-lint frontier [--all] [--json]
  product-lint ship [--all] [--full] [--json]
  product-lint adopt <path>... | --all [--json]
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

Common:
  --config <path>  Use an explicit product-lint.config.json.
  --json           Emit machine-readable JSON.
  --all            Ignore scope.roots for this run, and report the whole forest.
  --full           Print every finding with its repair, instead of the summary.

Exit codes:
  0  valid and complete for the selected command
  1  invalid
  2  structurally valid but product knowledge is incomplete
`;
}

function parseCommon(args: string[], allowPositionals = false) {
  return parseArgs({
    args,
    options: {
      config: { type: "string" },
      json: { type: "boolean", default: false },
      staged: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      full: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals,
    strict: true,
  });
}

function stringifyJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, item) =>
      item instanceof Set ? [...item] : item instanceof Map ? Object.fromEntries(item) : item,
    2,
  );
}

function emit(value: unknown, json: boolean): void {
  if (json) console.log(stringifyJson(value));
  else console.log(String(value));
}

type StatusCommand = "check" | "frontier" | "ship";

interface StatusReport {
  complete: boolean;
  dirty: boolean;
  scope?: ScopeSummary;
  graph?: KnowledgeGraph;
  ignored: { smell: string; nodeId?: string; because: string }[];
  /** Everything the command reports, in the order it reports it. */
  all: Diagnostic[];
  /** The subset that decides exit code 1, as against an incomplete frontier. */
  blocking: Diagnostic[];
}

/**
 * The working-tree read behind `check`, `frontier`, `ship`, and the compliance
 * half of `init`. It is one function because those commands must agree: an
 * `init` that reported a state its own `check` contradicts would teach the
 * reader to distrust both.
 */
async function statusReport(
  config: ResolvedConfig,
  command: StatusCommand,
  ignoreScope = false,
): Promise<StatusReport> {
  const status = await inspectWorkingTree(config, ignoreScope);
  const structural = status.validation.diagnostics;
  const sync = status.synchronization;
  const frontier = status.frontier.diagnostics;
  // Shape is a review and never a gate, so it joins what is reported and stays
  // out of what decides the exit code.
  const smells = status.smells.diagnostics;
  const dirty = command === "ship" ? await isWorkingTreeDirty(config.root) : false;
  const shipDiagnostics: Diagnostic[] = dirty
    ? [
        {
          code: "PL0701 DIRTY_SHIP_TREE",
          severity: "error",
          message: "Working tree must be clean before shipping.",
        },
      ]
    : [];
  return {
    complete: status.frontier.complete && !dirty,
    dirty,
    ...(status.frontier.scope ? { scope: status.frontier.scope } : {}),
    ...(status.validation.graph ? { graph: status.validation.graph } : {}),
    ignored: status.smells.ignored,
    all:
      command === "frontier"
        ? frontier
        : [...structural, ...sync, ...frontier, ...smells, ...shipDiagnostics],
    blocking: [...structural, ...sync, ...shipDiagnostics],
  };
}

/**
 * What scope held back, printed either side of the diagnostics.
 *
 * A scoped report is a quieter report, and quiet is exactly what a finished
 * repository looks like. Naming the roots above and the deferred count below is
 * what keeps a green `ship` from reading as "the product is done" when it means
 * "the two problems you chose are done".
 */
function renderScope(scope: ScopeSummary): { header: string; footer: string } {
  const total = scope.roots.length + scope.deferredRoots.length;
  const header = [
    `scope: ${scope.roots.length} of ${total} problems`,
    ...scope.roots.map((id) => `  ${id}`),
    `  because: ${scope.because}`,
    "",
  ].join("\n");
  const shared =
    scope.contested > 0 ? `, ${scope.contested} node(s) already shared with them` : "";
  const footer = [
    "",
    `deferred: ${scope.deferredRoots.length} problem(s), ${scope.deferred} obligation(s)${shared}`,
    "  product-lint check --all",
  ].join("\n");
  return { header, footer };
}

/**
 * 1 outranks 2. An invalid graph is not an incomplete one, and reporting the
 * softer code over a hard error would let a broken graph read as work in
 * progress.
 */
function applyStatusExitCode(report: StatusReport): void {
  if (hasErrors(report.blocking)) process.exitCode = 1;
  else if (!report.complete) process.exitCode = 2;
}

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }
  // `help` was a declared option that nothing read, so `product-lint check
  // --help` loaded the config and ran the check instead. Asking what a command
  // does is never a request to do it.
  if (rest.some((argument) => argument === "--help" || argument === "-h")) {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const parsed = parseCommon(rest);
    const result = await initProject(process.cwd(), parsed.values.force);
    // Provisioning is not an answer to "is this repository compliant", and on an
    // adoption install the two differ sharply: init creates empty level folders
    // beside a docs tree that may already hold nodes, and those nodes have never
    // been read. Telling the user to run `check` and stopping left the one moment
    // the tool has their attention unspent. So read back what init just wrote.
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const report = await statusReport(config, "check");
    if (parsed.values.json) {
      console.log(
        stringifyJson({
          ...result,
          check: {
            complete: report.complete,
            diagnostics: annotateDiagnostics(report.all),
          },
        }),
      );
    } else {
      for (const file of result.created) console.log(`created ${file}`);
      for (const file of result.skipped) console.log(`skipped ${file}`);
      if (result.notes.length > 0) console.log("");
      for (const note of result.notes) console.log(note);
      // Named, because the output changes subject here. Above is what init wrote;
      // below is what the working tree says, and an unlabelled diagnostic after a
      // list of created paths reads as a failure to create them.
      console.log("\nprovisioning done. checking the working tree:\n");
      process.stdout.write(formatDiagnostics(report.all));
    }
    applyStatusExitCode(report);
    return;
  }

  if (["validate", "check", "frontier", "ship"].includes(command)) {
    const parsed = parseCommon(rest);
    const config = await loadConfig(process.cwd(), parsed.values.config);
    if (command === "validate") {
      const snapshot = await createSnapshot(config, "working");
      const result = await validateSnapshot(config, snapshot);
      if (parsed.values.json) console.log(stringifyJson(annotateDiagnostics(result.diagnostics)));
      else process.stdout.write(formatDiagnostics(result.diagnostics));
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
      return;
    }

    const report = await statusReport(config, command as StatusCommand, parsed.values.all);
    if (parsed.values.json) {
      console.log(
        stringifyJson({
          complete: report.complete,
          ...(report.scope ? { scope: report.scope } : {}),
          diagnostics: annotateDiagnostics(report.all),
          ...(command === "ship" ? { dirty: report.dirty } : {}),
        }),
      );
    } else if (parsed.values.full || command === "frontier") {
      // `frontier` is never summarized: its whole job is to hand over the next
      // node to write, with the template, the question, and the siblings to read
      // first. A one-line row would delete exactly what it exists to deliver.
      const scope = report.scope ? renderScope(report.scope) : undefined;
      if (scope) console.log(scope.header);
      process.stdout.write(formatDiagnostics(report.all));
      if (scope) console.log(scope.footer);
    } else {
      process.stdout.write(
        renderSummary({
          diagnostics: report.all,
          ...(report.graph ? { graph: report.graph } : {}),
          ...(report.scope ? { scope: report.scope } : {}),
          ignored: report.ignored,
        }),
      );
    }
    applyStatusExitCode(report);
    return;
  }

  if (command === "smells") {
    const parsed = parseCommon(rest);
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const status = await inspectWorkingTree(config, parsed.values.all);
    if (hasErrors(status.validation.diagnostics)) {
      process.stdout.write(formatDiagnostics(status.validation.diagnostics));
      process.exitCode = 1;
      return;
    }
    const { smells } = status;
    if (parsed.values.json) {
      console.log(
        stringifyJson({
          diagnostics: annotateDiagnostics(smells.diagnostics),
          deferred: smells.deferred,
          ignored: smells.ignored,
        }),
      );
      return;
    }
    const drafts = [...status.validation.graph!.nodes.values()].filter((node) => node.draft).length;
    if (drafts > 0) {
      // Said out loud, because a quiet smell report over a drafted graph would
      // otherwise read as "the shape is fine" when it means "there is no shape yet".
      console.log(
        `${drafts} draft node(s) are not read for shape: scaffolding is not product structure.\n`,
      );
    }
    process.stdout.write(formatDiagnostics(smells.diagnostics));
    if (smells.deferred > 0) {
      console.log(`\n${smells.deferred} finding(s) not shown: their node is outside scope.roots.`);
    }
    for (const entry of smells.ignored) {
      console.log(
        `\nignored: ${entry.smell}${entry.nodeId ? ` on ${entry.nodeId}` : ""} — ${entry.because}`,
      );
    }
    // A review surface, never a gate, on the same standard as `vocabulary`.
    return;
  }

  if (command === "adopt") {
    const parsed = parseCommon(rest, true);
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const snapshot = await createSnapshot(config, "working");
    const validation = await validateSnapshot(config, snapshot);
    if (!validation.graph || hasErrors(validation.diagnostics)) {
      process.stdout.write(formatDiagnostics(validation.diagnostics));
      process.exitCode = 1;
      return;
    }
    if (parsed.positionals.length === 0 && !parsed.values.all) {
      throw new Error(
        "Name the files to adopt, or pass --all for every governed file with no owner.",
      );
    }
    const result = await adopt(config, validation.graph, snapshot, parsed.positionals);
    if (parsed.values.json) {
      console.log(stringifyJson(result));
      return;
    }
    if (result.clusters.length === 0) {
      console.log(
        result.alreadyOwned.length > 0
          ? `Nothing to adopt: ${result.alreadyOwned.length} file(s) already have a Mechanism owner.`
          : "Nothing to adopt: no governed file is missing an owner.",
      );
      return;
    }
    for (const cluster of result.clusters) {
      console.log(`${cluster.directory}/** — ${cluster.files.length} file(s)`);
      for (const id of cluster.nodes) console.log(`  ${id}`);
    }
    // Every one of them owes a sentence, and saying so here is the difference
    // between a scaffold and a claim that the graph now describes the product.
    console.log(
      `\n${result.written.length} draft node(s) written. Each owes a real statement:` +
        `\n  product-lint check\n\nRun: git add docs && product-lint knowledge sync --staged`,
    );
    return;
  }

  if (command === "vocabulary") {
    const parsed = parseCommon(rest);
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const snapshot = await createSnapshot(config, parsed.values.staged ? "staged" : "working");
    const validation = await validateSnapshot(config, snapshot);
    if (!validation.graph || hasErrors(validation.diagnostics)) {
      process.stdout.write(formatDiagnostics(validation.diagnostics));
      process.exitCode = 1;
      return;
    }
    const changedPaths = parsed.values.staged
      ? new Set(
          (await stagedChanges(config.root)).flatMap((change) => [
            change.path,
            ...(change.oldPath ? [change.oldPath] : []),
          ]),
        )
      : undefined;
    const report = vocabularyReport([...validation.graph.nodes.values()], validation.terms, {
      ...(changedPaths ? { changedPaths } : {}),
    });
    if (parsed.values.json) {
      console.log(
        stringifyJson({
          terms: report.terms,
          diagnostics: annotateDiagnostics(report.diagnostics),
        }),
      );
      return;
    }
    const counts = KNOWLEDGE_LEVELS.map(
      (level) => `${level} ${report.terms.filter((term) => term.level === level).length}`,
    ).join(", ");
    console.log(`terms declared (${report.terms.length}): ${counts}\n`);
    process.stdout.write(formatDiagnostics(report.diagnostics));
    // A review surface, never a gate: everything here is a judgement for a
    // human, so the exit code stays 0 on findings.
    return;
  }

  if (command === "term") {
    const [action, ...tail] = rest;
    if (action !== "reject") {
      throw new Error(`Unknown term action: ${action ?? "(none)"}\n\n${usage()}`);
    }
    const parsed = parseArgs({
      args: tail,
      options: {
        config: { type: "string" },
        json: { type: "boolean", default: false },
        wrong: { type: "boolean", default: false },
        taken: { type: "boolean", default: false },
        because: { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
    // A multi-word name survives either quoting: "false drop" arrives as one
    // positional, false drop as two.
    const [termId, ...nameParts] = parsed.positionals;
    const name = nameParts.join(" ");
    if (!termId || !name) {
      throw new Error(`Missing term id or name.\n\n  product-lint term reject <term-id> <name> --wrong|--taken --because <reason>\n`);
    }
    // Exactly one stance, never a default. Which of the two it is decides
    // whether the name is guarded or merely recorded, and guessing for the
    // author would put a guard on a word they said was spoken for.
    if (parsed.values.wrong === parsed.values.taken) {
      throw new Error(
        "Give exactly one stance.\n  --wrong  the word does not name this thing; the name is then refused to other declarations and reported in prose.\n  --taken  the word already names something else here; recorded, never enforced.",
      );
    }
    const because = parsed.values.because?.trim();
    if (!because) {
      throw new Error(
        "A rejection carries its reason: --because <text>. A bare list of names is a suppression list, not a decision.",
      );
    }

    const config = await loadConfig(process.cwd(), parsed.values.config);
    const snapshot = await createSnapshot(config, "working");
    const loaded = await loadTermNodes(config, snapshot);
    if (hasErrors(loaded.diagnostics)) {
      process.stdout.write(formatDiagnostics(loaded.diagnostics));
      process.exitCode = 1;
      return;
    }
    const result = recordRejection(loaded.terms, termId, {
      name,
      stance: parsed.values.wrong ? "wrong" : "taken",
      because,
    });
    if (!result.term) {
      if (parsed.values.json) console.log(stringifyJson(annotateDiagnostics(result.diagnostics)));
      else process.stdout.write(formatDiagnostics(result.diagnostics));
      process.exitCode = 1;
      return;
    }
    const file = path.join(config.root, result.term.sourcePath);
    await writeFile(file, serializeTermNode(result.term), "utf8");
    if (parsed.values.json) {
      console.log(stringifyJson({ term: result.term, path: result.term.sourcePath }));
      return;
    }
    const stance = parsed.values.wrong ? "wrong" : "taken";
    console.log(`${result.term.id} rejected "${name}" (${stance})`);
    console.log(`  because: ${because}`);
    console.log(`  ${result.term.sourcePath}`);
    return;
  }

  if (command === "knowledge" || command === "llms") {
    const [action, subject, ...tail] = rest;
    if (!action || !subject) throw new Error(`Missing ${command} action or subject.\n\n${usage()}`);
    if (command === "knowledge" && action === "sync") {
      const parsed = parseCommon([subject, ...tail]);
      if (!parsed.values.staged && subject !== "--staged") {
        throw new Error("knowledge sync currently requires --staged.");
      }
      const config = await loadConfig(process.cwd(), parsed.values.config);
      const result = await synchronizeStaged(config);
      if (parsed.values.json) {
        console.log(stringifyJson({ ...result, diagnostics: annotateDiagnostics(result.diagnostics) }));
      } else {
        for (const file of result.updatedFiles) console.log(`updated ${file}`);
        process.stdout.write(formatDiagnostics(result.diagnostics));
        if (result.updatedFiles.length > 0) console.log("Stage the updated JSON files before committing.");
      }
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
      return;
    }

    const parsed = parseCommon(tail);
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const snapshot = await createSnapshot(config, "working");
    const validation = await validateSnapshot(config, snapshot);
    if (!validation.graph || hasErrors(validation.diagnostics)) {
      process.stdout.write(formatDiagnostics(validation.diagnostics));
      process.exitCode = 1;
      return;
    }
    if (action === "for-file") {
      const result = knowledgeForFile(validation.graph, validation.references, subject);
      if (command === "llms") process.stdout.write(renderFileKnowledgeForLlm(result, validation.terms));
      else if (parsed.values.json) console.log(stringifyJson(result));
      else {
        if (result.audience) console.log(`audience: ${result.audience}`);
        emit(result.lineage.map((node) => `${node.id}\t${node.statement}`).join("\n"), false);
      }
      return;
    }
    if (action === "slice") {
      const result = sliceForAudience(validation.graph, snapshot, subject);
      if (parsed.values.json) {
        console.log(
          stringifyJson({
            ...result,
            keptNodes: result.keptNodes.map((node) => node.id),
            mockedNodes: result.mockedNodes.map((node) => node.id),
          }),
        );
      } else {
        console.log(`keep: ${result.keep}`);
        console.log(`  kept   ${result.keptNodes.length} node(s), ${result.keptFiles.length} file(s)`);
        for (const file of result.keptFiles) console.log(`    real ${file}`);
        console.log(`  mocked ${result.mockedNodes.length} node(s), ${result.mockedFiles.length} file(s)`);
        for (const file of result.mockedFiles) console.log(`    mock ${file}`);
        // Stated, never silent: these are the files a mock set grown from the
        // other audiences would have stubbed out from under the kept one.
        console.log(`  contested ${result.contestedFiles.length} file(s)`);
        for (const file of result.contestedFiles) console.log(`    both ${file}`);
      }
      return;
    }
    if (action === "affected-by") {
      // A term's blast radius is every text that speaks the word, which is a
      // different traversal from a node's descendants.
      if (subject.startsWith("term.")) {
        if (command === "llms") {
          throw new Error("llms affected-by takes a node id. Use: product-lint knowledge affected-by <term-id>");
        }
        const result = affectedByTerm(
          [...validation.graph.nodes.values()],
          validation.terms,
          subject,
        );
        if (parsed.values.json) console.log(stringifyJson(result));
        else {
          console.log(`term: ${result.term.id}`);
          console.log(`name: ${result.term.name}`);
          for (const node of result.nodes) console.log(`node: ${node.id}`);
          for (const term of result.terms) console.log(`term: ${term.id}`);
        }
        return;
      }
      const result = affectedByNode(validation.graph, validation.references, snapshot, subject);
      if (command === "llms") process.stdout.write(renderAffectedKnowledgeForLlm(result, validation.terms));
      else if (parsed.values.json) console.log(stringifyJson(result));
      else {
        if (result.audience) console.log(`audience: ${result.audience}`);
        console.log(`node: ${result.node.id}`);
        for (const node of result.descendants) console.log(`node: ${node.id}`);
        for (const file of result.files) console.log(`file: ${file}`);
      }
      return;
    }
    throw new Error(`Unknown ${command} action: ${action}`);
  }

  if (command === "commit") {
    const [action, subject, ...tail] = rest;
    if (action === "check") {
      const parsed = parseCommon([subject, ...tail].filter((item) => item !== undefined));
      if (!parsed.values.staged && subject !== "--staged") {
        throw new Error("commit check requires --staged.");
      }
      const config = await loadConfig(process.cwd(), parsed.values.config);
      const result = await checkStagedCommit(config);
      if (parsed.values.json) {
        console.log(stringifyJson({ ...result, diagnostics: annotateDiagnostics(result.diagnostics) }));
      } else process.stdout.write(formatDiagnostics(result.diagnostics));
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
      return;
    }
    if (action === "message") {
      if (!subject) throw new Error("commit message requires a commit-message file path.");
      const parsed = parseCommon(tail);
      const config = await loadConfig(process.cwd(), parsed.values.config);
      const result = await checkCommitMessage(config, path.resolve(subject));
      if (parsed.values.json) {
        console.log(stringifyJson({ ...result, diagnostics: annotateDiagnostics(result.diagnostics) }));
      } else process.stdout.write(formatDiagnostics(result.diagnostics));
      if (hasErrors(result.diagnostics)) process.exitCode = 1;
      return;
    }
    throw new Error(`Unknown commit action: ${String(action)}`);
  }

  throw new Error(`Unknown command: ${command}\n\n${usage()}`);
}

main().catch((error) => {
  if (!(error instanceof Error)) console.error(String(error));
  else if (process.env.PRODUCT_LINT_DEBUG) console.error(error.stack ?? error.message);
  else console.error(error.message);
  process.exitCode = 1;
});
