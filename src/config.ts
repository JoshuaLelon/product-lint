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
      ...(input.commit?.subjectPattern ? { subjectPattern: input.commit.subjectPattern } : {}),
    },
    attest: {
      // On by default at the three levels where overlap has no other detector.
      //
      // Mechanism is left out, and not because it matters less: PL0603 already
      // decides the part of it that files can settle, and Mechanism cohorts are
      // the largest, so asking there costs the most attention for the least new
      // information.
      //
      // These read as `info` during `check` and `commit check`, so an unreviewed
      // level never blocks a commit. Only `ship` treats them as errors. A level
      // nobody has read since it changed is exactly what a shipping gate is for,
      // and a commit gate would only teach --no-verify.
      levels: (input.attest?.levels ?? ["product", "behavior", "architecture"]).filter(
        (level): level is KnowledgeLevel =>
          (KNOWLEDGE_LEVELS as readonly string[]).includes(level),
      ),
    },
  };
}
