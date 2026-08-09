#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { formatDiagnostics, hasErrors } from "./diagnostics.js";
import { annotateDiagnostics } from "./remediation.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { inspectWorkingTree } from "./status.js";
import { knowledgeForFile, affectedByNode } from "./queries.js";
import { renderAffectedKnowledgeForLlm, renderFileKnowledgeForLlm } from "./llms.js";
import { synchronizeStaged } from "./sync.js";
import { checkCommitMessage, checkStagedCommit } from "./commit.js";
import { initProject } from "./init.js";
import { isWorkingTreeDirty } from "./git.js";

function usage(): string {
  return `Product Lint

Usage:
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

Common:
  --config <path>  Use an explicit product-lint.config.json.
  --json           Emit machine-readable JSON.

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

async function main(): Promise<void> {
  const [command = "help", ...rest] = process.argv.slice(2);
  if (["help", "--help", "-h"].includes(command)) {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const parsed = parseCommon(rest);
    const result = await initProject(process.cwd(), parsed.values.force);
    if (parsed.values.json) console.log(stringifyJson(result));
    else {
      for (const file of result.created) console.log(`created ${file}`);
      for (const file of result.skipped) console.log(`skipped ${file}`);
      if (result.notes.length > 0) console.log("");
      for (const note of result.notes) console.log(note);
      console.log("\nRun: product-lint check");
    }
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

    const status = await inspectWorkingTree(config);
    const structural = status.validation.diagnostics;
    const sync = status.synchronization;
    const frontier = status.frontier.diagnostics;
    const dirty = command === "ship" ? await isWorkingTreeDirty(config.root) : false;
    const shipDiagnostics = dirty
      ? [{
          code: "PL0701 DIRTY_SHIP_TREE",
          severity: "error" as const,
          message: "Working tree must be clean before shipping.",
        }]
      : [];
    const all = command === "frontier"
      ? frontier
      : [...structural, ...sync, ...frontier, ...shipDiagnostics];
    if (parsed.values.json) {
      console.log(
        stringifyJson({
          complete: status.frontier.complete && !dirty,
          diagnostics: annotateDiagnostics(all),
          ...(command === "ship" ? { dirty } : {}),
        }),
      );
    } else {
      process.stdout.write(formatDiagnostics(all));
    }
    if (hasErrors([...structural, ...sync, ...shipDiagnostics])) process.exitCode = 1;
    else if (!status.frontier.complete) process.exitCode = 2;
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
      if (command === "llms") process.stdout.write(renderFileKnowledgeForLlm(result));
      else if (parsed.values.json) console.log(stringifyJson(result));
      else emit(result.lineage.map((node) => `${node.id}\t${node.statement}`).join("\n"), false);
      return;
    }
    if (action === "affected-by") {
      const result = affectedByNode(validation.graph, validation.references, snapshot, subject);
      if (command === "llms") process.stdout.write(renderAffectedKnowledgeForLlm(result));
      else if (parsed.values.json) console.log(stringifyJson(result));
      else {
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
