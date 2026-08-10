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
import { formatSpectrum } from "./spectrum.js";
import { acceptBaseline, compareToBaseline, readBaseline } from "./baseline.js";

function usage(): string {
  return `Product Lint

Usage:
  product-lint init [--force]
  product-lint validate [--json]
  product-lint check [--json]
  product-lint frontier [--json]
  product-lint spectrum [--json]
  product-lint accept --reason <why> [--allow-regression]
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
    if (parsed.values.json) console.log(stringifyJson(result));
    else {
      for (const file of result.created) console.log(`created ${file}`);
      for (const file of result.skipped) console.log(`skipped ${file}`);
      if (result.notes.length > 0) console.log("");
      for (const note of result.notes) console.log(note);
      console.log("\nRun: npx product-lint check");
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
          spectrum: status.spectrum,
          ...(command === "ship" ? { dirty } : {}),
        }),
      );
    } else {
      process.stdout.write(formatDiagnostics(all));
      if (command !== "frontier") process.stdout.write(`\n${formatSpectrum(status.spectrum)}`);
    }
    if (hasErrors([...structural, ...sync, ...shipDiagnostics])) process.exitCode = 1;
    else if (!status.frontier.complete) process.exitCode = 2;
    return;
  }

  if (command === "spectrum") {
    const parsed = parseCommon(rest);
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const status = await inspectWorkingTree(config);
    const baseline = await readBaseline(config.root);
    const ratchet = compareToBaseline(status.spectrum, baseline, { announceMissing: true });
    if (parsed.values.json) {
      console.log(
        stringifyJson({ spectrum: status.spectrum, diagnostics: annotateDiagnostics(ratchet) }),
      );
    } else {
      process.stdout.write(formatSpectrum(status.spectrum));
      if (ratchet.length > 0) process.stdout.write(`\n${formatDiagnostics(ratchet)}`);
    }
    if (hasErrors(ratchet)) process.exitCode = 1;
    // A masked band is unmeasured work, not a clean result. Reporting it as
    // success is exactly the failure this vector exists to make unstateable.
    else if (status.spectrum.bands.some((band) => band.state.kind !== "clean")) {
      process.exitCode = 2;
    }
    return;
  }

  if (command === "accept") {
    const parsed = parseArgs({
      args: rest,
      options: {
        config: { type: "string" },
        json: { type: "boolean", default: false },
        reason: { type: "string" },
        "allow-regression": { type: "boolean", default: false },
        help: { type: "boolean", default: false },
      },
      strict: true,
    });
    const config = await loadConfig(process.cwd(), parsed.values.config);
    const result = await acceptBaseline(config, {
      reason: parsed.values.reason,
      allowRegression: parsed.values["allow-regression"],
    });
    if (parsed.values.json) console.log(stringifyJson(result));
    else {
      process.stdout.write(formatDiagnostics(result.diagnostics));
      if (result.written) console.log(`recorded ${result.written}`);
    }
    if (hasErrors(result.diagnostics)) process.exitCode = 1;
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
