import type {
  Diagnostic,
  FrontierResult,
  RepositorySnapshot,
  ResolvedConfig,
  ValidationResult,
} from "./types.js";
import { createSnapshot } from "./repository.js";
import { validateSnapshot } from "./validation.js";
import { synchronizationDiagnostics } from "./sync.js";
import { detectFrontier } from "./frontier.js";
import { resolveScope, scopeDiagnostics } from "./scope.js";
import { detectSmells, smellConfigDiagnostics, type SmellReport } from "./smells.js";
import { standingMistakeDiagnostics } from "./mistakes.js";

export interface ProductStatus {
  validation: ValidationResult;
  synchronization: Diagnostic[];
  frontier: FrontierResult;
  /** Shape findings. Always a review, never a gate: exit code is unaffected. */
  smells: SmellReport;
  /** Recorded mistakes whose node has not changed since. Review, never a gate. */
  mistakes: Diagnostic[];
}

export async function inspectWorkingTree(
  config: ResolvedConfig,
  /** `--all` widens for one invocation. Widening needs no recorded reason. */
  ignoreScope = false,
): Promise<ProductStatus> {
  return inspectSnapshot(config, await createSnapshot(config, "working"), ignoreScope);
}

/**
 * The same read against any snapshot. The commit brief takes the STAGED one,
 * because it describes the state the commit is about to create rather than
 * whatever happens to be on disk beside it.
 */
export async function inspectSnapshot(
  config: ResolvedConfig,
  snapshot: RepositorySnapshot,
  ignoreScope = false,
): Promise<ProductStatus> {
  const validation = await validateSnapshot(config, snapshot);

  if (!validation.graph) {
    return {
      validation,
      synchronization: [],
      frontier: { complete: false, diagnostics: [] },
      smells: { diagnostics: [], deferred: 0, ignored: [] },
      mistakes: [],
    };
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
      diagnostics: [...validation.diagnostics, ...scopeErrors, ...smellConfigDiagnostics(config)],
    },
    synchronization,
    frontier,
    smells: detectSmells(config, validation.graph, scope),
    mistakes: (
      await standingMistakeDiagnostics(config, validation.graph, validation.references, scope)
    ).diagnostics,
  };
}
