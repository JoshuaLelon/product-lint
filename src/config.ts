import path from "node:path";
import { readFile } from "node:fs/promises";
import type { KnowledgeLevel, ProductLintConfig, ResolvedConfig } from "./types.js";
import { KNOWLEDGE_LEVELS } from "./types.js";

const DEFAULT_CONFIG_NAME = "product-lint.config.json";

async function readJsonFile<T>(file: string): Promise<T> {
  const text = await readFile(file, "utf8");
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${String(error)}`);
  }
}

export async function loadConfig(cwd = process.cwd(), explicit?: string): Promise<ResolvedConfig> {
  const configPath = path.resolve(cwd, explicit ?? DEFAULT_CONFIG_NAME);
  let input: ProductLintConfig;
  try {
    input = await readJsonFile<ProductLintConfig>(configPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `No Product Lint configuration at ${configPath}.\nRun: npx product-lint init`,
      );
    }
    throw error;
  }
  const root = path.resolve(path.dirname(configPath), input.root ?? ".");
  const knowledgeRoot = path.resolve(root, input.knowledgeRoot ?? "docs");
  const canonicalRoots = Object.fromEntries(
    KNOWLEDGE_LEVELS.map((level) => [level, path.join(knowledgeRoot, level)]),
  ) as Record<KnowledgeLevel, string>;

  // A scope that silences seven problems without saying why is a suppression
  // list. Thrown rather than reported, the way invalid JSON is: a config the
  // tool cannot trust must not produce a quieter report than no config at all.
  const scopeRoots = input.scope?.roots ?? [];
  if (scopeRoots.length > 0 && !input.scope?.because?.trim()) {
    throw new Error(
      `scope.roots defers work, so it carries its reason: add scope.because to ${configPath}.`,
    );
  }

  // Same standard as scope: silencing a finding is a decision, and a decision
  // without its reason is a suppression list.
  const ignores = input.smells?.ignore ?? [];
  for (const entry of ignores) {
    if (!entry?.smell?.trim() || !entry?.because?.trim()) {
      throw new Error(
        `Every smells.ignore entry names a smell and says why it is ignored: fix ${configPath}.`,
      );
    }
  }

  return {
    root,
    configPath,
    knowledgeRoot,
    canonicalRoots,
    referenceRoot: path.join(knowledgeRoot, "reference"),
    ...(scopeRoots.length > 0
      ? { scope: { roots: scopeRoots, because: input.scope!.because.trim() } }
      : {}),
    ...(ignores.length > 0
      ? {
          smells: {
            ignore: ignores.map((entry) => ({
              smell: entry.smell.trim(),
              ...(entry.node ? { node: entry.node.trim() } : {}),
              because: entry.because.trim(),
            })),
          },
        }
      : {}),
    governedPaths: {
      include: input.governedPaths?.include ?? ["src/**", "test/**", "tests/**", "scripts/**"],
      exclude: input.governedPaths?.exclude ?? [
        "node_modules/**",
        "dist/**",
        "build/**",
        ".git/**",
        "docs/**",
      ],
    },
    commit: {
      trailer: input.commit?.trailer ?? "Knowledge-Change",
      removedTrailer: input.commit?.removedTrailer ?? "Knowledge-Removed",
      renamedTrailer: input.commit?.renamedTrailer ?? "Knowledge-Renamed",
      requireBody: input.commit?.requireBody ?? true,
      ...(input.commit?.subjectPattern ? { subjectPattern: input.commit.subjectPattern } : {}),
    },
  };
}
