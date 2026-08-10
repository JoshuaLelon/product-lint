import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Band, BandName, Diagnostic, ResolvedConfig, Spectrum } from "./types.js";
import { BAND_NAMES } from "./types.js";
import { digest, stableStringify } from "./stable-json.js";
import { describe } from "./spectrum.js";
import { isWorkingTreeDirty } from "./git.js";
import { inspectWorkingTree } from "./status.js";

export const BASELINE_DIRECTORY = ".product-lint";
export const BASELINE_FILE = "baseline.json";

export interface BaselineBand {
  state: "clean" | "measured" | "masked";
  residual?: number;
}

export interface Baseline {
  schemaVersion: 1;
  reason: string;
  bands: Record<string, BaselineBand>;
  digest: string;
}

export function baselinePath(root: string): string {
  return path.join(root, BASELINE_DIRECTORY, BASELINE_FILE);
}

/**
 * Only band names, states, and integer residuals reach the digest.
 *
 * Never a score and never a file list. A score computed from the corpus moves
 * when an unrelated node is added, and a file list churns on every rename;
 * either one makes the digest unreproducible, which is the one property this
 * codebase never gives up.
 */
export function baselineDigest(bands: Record<string, BaselineBand>): string {
  return digest(bands, "product-lint-baseline-v1");
}

export function baselineFrom(spectrum: Spectrum, reason: string): Baseline {
  const bands: Record<string, BaselineBand> = {};
  for (const band of spectrum.bands) {
    bands[band.name] =
      band.state.kind === "measured"
        ? { state: "measured", residual: band.state.residual }
        : { state: band.state.kind === "clean" ? "clean" : "masked" };
  }
  return { schemaVersion: 1, reason, bands, digest: baselineDigest(bands) };
}

export async function readBaseline(root: string): Promise<Baseline | undefined> {
  try {
    const text = await readFile(baselinePath(root), "utf8");
    const parsed = JSON.parse(text) as Baseline;
    if (!parsed || typeof parsed !== "object" || !parsed.bands) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

export async function writeBaseline(root: string, baseline: Baseline): Promise<string> {
  const target = baselinePath(root);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, `${stableStringify(baseline, 2)}\n`, "utf8");
  return target;
}

/**
 * The ratchet.
 *
 * Per band, never summed. A single score lets an improvement in one property
 * hide a regression in another, and separating them is the entire reason the
 * spectrum is a vector.
 *
 * The masked cases carry the weight. An unknown is not a zero, so a band that
 * was masked and is now measured is NOT a regression from nothing — it is the
 * first time the number existed. Comparing it would punish the commit that made
 * the graph measurable, which is the commit that did the most good.
 */
export function compareToBaseline(
  spectrum: Spectrum,
  baseline: Baseline | undefined,
  options: { announceMissing?: boolean } = {},
): Diagnostic[] {
  // Silence is right on the commit path. A repository that never opted into a
  // floor would otherwise be told so on every single commit, and a notice that
  // arrives every time is one nobody reads — the same reason the shape rule
  // rides six diagnostics instead of all fifty. `spectrum` asks about the
  // ratchet directly, so that is where the absence is worth naming.
  if (!baseline) {
    if (!options.announceMissing) return [];
    return [
      {
        code: "PL0902 MISSING_BASELINE",
        severity: "info",
        message: "No band baseline is recorded, so no regression can be detected.",
        action: "run-command",
        command: 'product-lint accept --reason "<why this is the floor>"',
      },
    ];
  }

  const diagnostics: Diagnostic[] = [];
  for (const band of spectrum.bands) {
    const previous = baseline.bands[band.name];
    if (!previous) {
      diagnostics.push(bandNowMeasurable(band, "the baseline predates this band"));
      continue;
    }
    const current = band.state;

    if (previous.state === "masked" && current.kind !== "masked") {
      diagnostics.push(bandNowMeasurable(band, "it was masked when the baseline was accepted"));
      continue;
    }
    if (previous.state !== "masked" && current.kind === "masked") {
      diagnostics.push({
        code: "PL0904 BAND_LOST_MEASURABILITY",
        severity: "info",
        message: `${band.name} can no longer be measured: ${describe(band)}.`,
        details: { band: band.name, was: previous.residual ?? 0 },
      });
      continue;
    }
    if (current.kind === "masked") continue;

    const before = previous.state === "clean" ? 0 : (previous.residual ?? 0);
    const after = current.kind === "clean" ? 0 : current.residual;

    if (after > before) {
      diagnostics.push({
        code: "PL0901 BAND_REGRESSION",
        severity: "error",
        message: `${band.name} rose from ${before} to ${after}. ${band.title}`,
        action: "edit-node",
        details: {
          band: band.name,
          baseline: before,
          current: after,
          // The findings ARE the evidence for the number, so the paths that
          // moved it are the work list.
          files: band.findings.map((finding) => finding.path).filter(Boolean),
        },
      });
    } else if (after < before) {
      diagnostics.push({
        code: "PL0905 BAND_IMPROVED",
        severity: "info",
        message: `${band.name} fell from ${before} to ${after}. Lower the floor to hold the gain.`,
        action: "run-command",
        command: 'product-lint accept --reason "<what closed>"',
        details: { band: band.name, baseline: before, current: after },
      });
    }
  }
  return diagnostics;
}

function bandNowMeasurable(band: Band, because: string): Diagnostic {
  return {
    code: "PL0903 BAND_NOW_MEASURABLE",
    severity: "info",
    message: `${band.name} is now ${describe(band)}, and ${because}. An unknown is not a regression from zero.`,
    action: "run-command",
    command: 'product-lint accept --reason "<why this is the floor>"',
    details: { band: band.name },
  };
}

export function bandNames(): readonly BandName[] {
  return BAND_NAMES;
}

export interface AcceptOptions {
  reason?: string;
  allowRegression?: boolean;
}

export interface AcceptResult {
  written?: string;
  baseline?: Baseline;
  diagnostics: Diagnostic[];
}

/**
 * Record the current counts as the floor.
 *
 * The gates exist because a floor is a promise, and a promise recorded without
 * looking is worth less than none. Lowering it is free; raising it costs a
 * flag and a stated reason that lands in a committed file, so a raise shows up
 * in review as a line somebody has to defend rather than a number that drifted.
 *
 * Never called from the hook. A pre-commit step that rewrites a committed file
 * behind the author is the rubber stamp with extra steps.
 */
export async function acceptBaseline(
  config: ResolvedConfig,
  options: AcceptOptions = {},
): Promise<AcceptResult> {
  const reason = options.reason?.trim();
  if (!reason) {
    return {
      diagnostics: [
        {
          code: "PL0906 UNEXPLAINED_ACCEPT",
          severity: "error",
          message: "Recording a floor needs a reason.",
          action: "run-command",
          command: 'product-lint accept --reason "<why this is the floor>"',
        },
      ],
    };
  }
  if (await isWorkingTreeDirty(config.root)) {
    return {
      diagnostics: [
        {
          code: "PL0907 DIRTY_ACCEPT_TREE",
          severity: "error",
          message: "Working tree must be clean before recording a floor.",
          action: "run-command",
          command: "git status",
        },
      ],
    };
  }

  const status = await inspectWorkingTree(config);
  const spectrum = status.spectrum;
  const previous = await readBaseline(config.root);
  const raised = raisedBands(spectrum, previous);
  if (raised.length > 0 && !options.allowRegression) {
    return {
      diagnostics: [
        {
          code: "PL0908 UNDECLARED_RAISE",
          severity: "error",
          message: `Recording this floor would raise ${raised.join(", ")}.`,
          action: "run-command",
          command: `product-lint accept --reason "${reason}" --allow-regression`,
          details: { bands: raised },
        },
      ],
    };
  }

  const baseline = baselineFrom(spectrum, reason);
  const written = await writeBaseline(config.root, baseline);
  return {
    written: path.relative(config.root, written),
    baseline,
    diagnostics: [],
  };
}

function raisedBands(spectrum: Spectrum, previous: Baseline | undefined): string[] {
  if (!previous) return [];
  const raised: string[] = [];
  for (const band of spectrum.bands) {
    const before = previous.bands[band.name];
    if (!before || before.state === "masked") continue;
    if (band.state.kind === "masked") continue;
    const was = before.state === "clean" ? 0 : (before.residual ?? 0);
    const now = band.state.kind === "clean" ? 0 : band.state.residual;
    if (now > was) raised.push(`${band.name} ${was}->${now}`);
  }
  return raised;
}
