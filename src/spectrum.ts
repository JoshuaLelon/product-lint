import type {
  Band,
  BandName,
  Diagnostic,
  KnowledgeGraph,
  MaskReason,
  RepositorySnapshot,
  ResolvedConfig,
  Spectrum,
} from "./types.js";
import { BAND_NAMES } from "./types.js";
import { governedFiles } from "./frontier.js";
import { matchesAny } from "./glob.js";

/**
 * What each band cannot be measured without.
 *
 * Static on purpose. "You cannot measure coverage on a graph that does not
 * build" is a claim about meaning, not something recoverable from the numbers,
 * and a derived version would put the doctrine somewhere nobody reads it.
 *
 * BAND_NAMES is a topological order of this table, asserted by a test, so the
 * evaluator is one forward pass.
 */
export const BAND_DEPENDENCIES: Record<BandName, BandName[]> = {
  STRUCTURE: [],
  COVERAGE: ["STRUCTURE"],
  OVERLAP: ["STRUCTURE"],
};

const TITLES: Record<BandName, string> = {
  STRUCTURE: "The graph parses, resolves, and has no cycle.",
  COVERAGE: "Every governed file has a Mechanism owner.",
  OVERLAP: "No governed file has two Mechanism owners.",
};

export interface SpectrumInput {
  config: ResolvedConfig;
  snapshot: RepositorySnapshot;
  graph?: KnowledgeGraph;
  /** Diagnostics already produced by validation, classified into bands. */
  diagnostics: Diagnostic[];
}

/**
 * Measure every band, or say why a band could not be measured.
 *
 * The one rule that matters: a band that could not be measured reports MASKED
 * and carries no number. It never reports zero. Reporting an unmeasured band as
 * clean is how `ship` once printed MISSING_CONTEXT alone on a repository with
 * 317 unowned files — the count existed and the code returned before reaching
 * it. Here the type makes that unstateable rather than merely discouraged.
 */
export function computeSpectrum(input: SpectrumInput): Spectrum {
  const bands: Band[] = [];
  const stateByName = new Map<BandName, Band>();

  for (const name of BAND_NAMES) {
    const blocker = BAND_DEPENDENCIES[name].find(
      (dependency) => stateByName.get(dependency)?.state.kind !== "clean",
    );
    if (blocker) {
      const band = masked(name, { band: blocker });
      bands.push(band);
      stateByName.set(name, band);
      continue;
    }
    const band = measure(name, input);
    bands.push(band);
    stateByName.set(name, band);
  }

  return { snapshot: input.snapshot.kind, bands };
}

function masked(name: BandName, by: MaskReason): Band {
  return { name, title: TITLES[name], state: { kind: "masked", by }, findings: [] };
}

function measure(name: BandName, input: SpectrumInput): Band {
  const findings = findingsFor(name, input);
  return {
    name,
    title: TITLES[name],
    // The residual IS the finding count. Keeping them one number means the
    // baseline is an integer vector and the findings are its evidence, so a
    // ratchet can never disagree with what the tool printed.
    state: findings.length === 0 ? { kind: "clean" } : { kind: "measured", residual: findings.length },
    findings,
  };
}

function findingsFor(name: BandName, input: SpectrumInput): Diagnostic[] {
  if (name === "STRUCTURE") {
    return input.diagnostics.filter(
      (item) => item.severity === "error" && !isOverlap(item) && !isCoverage(item),
    );
  }
  if (name === "OVERLAP") return input.diagnostics.filter(isOverlap);
  return unownedFiles(input);
}

function isOverlap(diagnostic: Diagnostic): boolean {
  return diagnostic.code === "PL0603 OVERLAPPING_MECHANISM";
}

function isCoverage(diagnostic: Diagnostic): boolean {
  return (
    diagnostic.code === "PL0601 UNMAPPED_FILE" || diagnostic.code === "PL0602 UNGOVERNED_TREE"
  );
}

/**
 * Counted directly rather than read off frontier diagnostics, because frontier
 * collapses the per-file list into one PL0602 when no Mechanism can exist yet.
 * That is the right shape to READ and the wrong shape to COUNT: a ratchet needs
 * the number of unowned files, not the number of times the tool said so.
 */
function unownedFiles(input: SpectrumInput): Diagnostic[] {
  if (!input.graph) return [];
  const mechanisms = [...input.graph.nodes.values()].filter(
    (node) => node.level === "mechanism" && node.implementation,
  );
  return governedFiles(input.config, input.snapshot)
    .filter((file) => !mechanisms.some((node) => matchesAny(file, node.implementation!.files)))
    .map((file) => ({
      code: "PL0601 UNMAPPED_FILE",
      severity: "info" as const,
      message: `${file} is governed but has no Mechanism owner.`,
      path: file,
    }));
}

export function bandByName(spectrum: Spectrum, name: BandName): Band {
  return spectrum.bands.find((band: Band) => band.name === name)!;
}

export function formatSpectrum(spectrum: Spectrum): string {
  const lines = [`Product Lint spectrum (${spectrum.snapshot} tree)`];
  for (const band of spectrum.bands) {
    lines.push(`  ${band.name.padEnd(10)} ${describe(band)}`);
  }
  return `${lines.join("\n")}\n`;
}

export function describe(band: Band): string {
  if (band.state.kind === "clean") return "clean";
  if (band.state.kind === "measured") return `measured(${band.state.residual})`;
  const by = band.state.by;
  return "band" in by ? `masked by ${by.band}` : `masked (${by.rule})`;
}
