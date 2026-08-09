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
  const input = await readJsonFile<ProductLintConfig>(configPath);
  const root = path.resolve(path.dirname(configPath), input.root ?? ".");
  const knowledgeRoot = path.resolve(root, input.knowledgeRoot ?? "docs");
  const canonicalRoots = Object.fromEntries(
    KNOWLEDGE_LEVELS.map((level) => [level, path.join(knowledgeRoot, level)]),
  ) as Record<KnowledgeLevel, string>;

  return {
    root,
    configPath,
    knowledgeRoot,
    canonicalRoots,
    referenceRoot: path.join(knowledgeRoot, "reference"),
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
      requireBody: input.commit?.requireBody ?? true,
    },
  };
}
