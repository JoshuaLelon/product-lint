import type { Diagnostic, FrontierResult, ResolvedConfig, ValidationResult } from "./types.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { synchronizationDiagnostics } from "./sync.js";
import { detectFrontier } from "./frontier.js";
import { resolveScope, scopeDiagnostics } from "./scope.js";

export interface ProductStatus {
  validation: ValidationResult;
  synchronization: Diagnostic[];
  frontier: FrontierResult;
}

export async function inspectWorkingTree(
  config: ResolvedConfig,
  /** `--all` widens for one invocation. Widening needs no recorded reason. */
  ignoreScope = false,
): Promise<ProductStatus> {
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
  // A root naming nothing scopes the graph to nothing and every report goes
  // quiet, so it is an error on the validation side rather than a silence here.
  const scopeErrors = scopeDiagnostics(config, validation.graph);
  const scope = ignoreScope ? undefined : resolveScope(config, validation.graph);
  const frontier = detectFrontier(config, validation.graph, snapshot, validation.terms, scope);
  return {
    validation: {
      ...validation,
      diagnostics: [...validation.diagnostics, ...scopeErrors],
    },
    synchronization,
    frontier,
  };
}
