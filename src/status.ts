import type {
  Diagnostic,
  FrontierResult,
  ResolvedConfig,
  Spectrum,
  ValidationResult,
} from "./types.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { synchronizationDiagnostics } from "./sync.js";
import { detectFrontier } from "./frontier.js";
import { computeSpectrum } from "./spectrum.js";

export interface ProductStatus {
  validation: ValidationResult;
  synchronization: Diagnostic[];
  frontier: FrontierResult;
  spectrum: Spectrum;
}

export async function inspectWorkingTree(config: ResolvedConfig): Promise<ProductStatus> {
  const snapshot = await createSnapshot(config, "working");
  const validation = await validateSnapshot(config, snapshot);

  // A graph that does not build still has a spectrum. It reports STRUCTURE with
  // a real count and every other band MASKED — never clean, and never zero,
  // because nothing downstream was looked at. Returning empty results here is
  // the shape of bug that once let `ship` report one missing node on a
  // repository with 317 unowned files.
  if (!validation.graph) {
    return {
      validation,
      synchronization: [],
      frontier: { complete: false, diagnostics: [] },
      spectrum: computeSpectrum({ config, snapshot, diagnostics: validation.diagnostics }),
    };
  }

  const synchronization = await synchronizationDiagnostics(
    validation.graph,
    snapshot,
    "product-lint knowledge sync --staged",
  );
  const frontier = detectFrontier(config, validation.graph, snapshot);
  const spectrum = computeSpectrum({
    config,
    snapshot,
    graph: validation.graph,
    diagnostics: validation.diagnostics,
  });
  return { validation, synchronization, frontier, spectrum };
}
