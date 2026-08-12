import type { Diagnostic, FrontierResult, ResolvedConfig, ValidationResult } from "./types.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { synchronizationDiagnostics } from "./sync.js";
import { detectFrontier } from "./frontier.js";

export interface ProductStatus {
  validation: ValidationResult;
  synchronization: Diagnostic[];
  frontier: FrontierResult;
}

export async function inspectWorkingTree(config: ResolvedConfig): Promise<ProductStatus> {
  const snapshot = await createSnapshot(config, "working");
  const validation = await validateSnapshot(config, snapshot);

  if (!validation.graph) {
    return { validation, synchronization: [], frontier: { complete: false, diagnostics: [] } };
  }

  const synchronization = await synchronizationDiagnostics(
    validation.graph,
    snapshot,
    "product-lint knowledge sync --staged",
    undefined,
    validation.terms,
  );
  const frontier = detectFrontier(config, validation.graph, snapshot, validation.terms);
  return { validation, synchronization, frontier };
}
