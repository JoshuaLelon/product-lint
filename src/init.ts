import path from "node:path";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { KNOWLEDGE_LEVELS } from "./types.js";

const run = promisify(execFile);

export interface InitResult {
  created: string[];
  skipped: string[];
  notes: string[];
}

const KNOWLEDGE_DIRECTORIES = [...KNOWLEDGE_LEVELS, "reference"] as const;

const LEFTHOOK_FILENAMES = [
  "lefthook.yml",
  "lefthook.yaml",
  ".lefthook.yml",
  ".lefthook.yaml",
];

const PRE_COMMIT_BLOCK = `pre-commit:
  piped: true
  commands:
    1_product-lint-sync:
      run: npx product-lint knowledge sync --staged && git add docs/
    2_product-lint-check:
      run: npx product-lint commit check --staged
`;

const COMMIT_MSG_BLOCK = `commit-msg:
  commands:
    product-lint:
      run: npx product-lint commit message {1}
`;

async function exists(entry: string): Promise<boolean> {
  try {
    await stat(entry);
    return true;
  } catch {
    return false;
  }
}

async function findLefthookConfig(root: string): Promise<string | undefined> {
  for (const name of LEFTHOOK_FILENAMES) {
    const candidate = path.join(root, name);
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Lefthook merges top-level hook keys, so an existing config is extended rather
 * than rewritten. Only the hooks Product Lint owns are appended, and only when
 * they do not already mention product-lint.
 */
async function configureLefthook(root: string, result: InitResult): Promise<void> {
  const existing = await findLefthookConfig(root);
  const target = existing ?? path.join(root, "lefthook.yml");

  if (!existing) {
    await writeFile(target, `${PRE_COMMIT_BLOCK}\n${COMMIT_MSG_BLOCK}`, "utf8");
    result.created.push(target);
    return;
  }

  const current = await readFile(target, "utf8");
  if (current.includes("product-lint")) {
    result.skipped.push(target);
    result.notes.push(`${path.basename(target)} already references product-lint; left unchanged.`);
    return;
  }

  const additions: string[] = [];
  if (!/^pre-commit:/m.test(current)) additions.push(PRE_COMMIT_BLOCK);
  if (!/^commit-msg:/m.test(current)) additions.push(COMMIT_MSG_BLOCK);

  if (additions.length === 0) {
    result.skipped.push(target);
    result.notes.push(
      `${path.basename(target)} already defines pre-commit and commit-msg. Add these commands manually:\n` +
        `  pre-commit:  npx product-lint knowledge sync --staged && git add docs/\n` +
        `  pre-commit:  npx product-lint commit check --staged\n` +
        `  commit-msg:  npx product-lint commit message {1}`,
    );
    return;
  }

  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  await writeFile(target, `${current}${separator}${additions.join("\n")}`, "utf8");
  result.created.push(`${target} (appended)`);
}

/**
 * Hooks are worthless until they are installed into .git/hooks, so do it here
 * rather than leaving it as a step the user has to remember.
 */
async function installLefthookHooks(root: string, result: InitResult): Promise<void> {
  try {
    await run("npx", ["--no-install", "lefthook", "install"], { cwd: root });
    result.notes.push("Installed Git hooks via lefthook.");
  } catch {
    result.notes.push(
      "Could not run lefthook automatically. Install it, then run: npx lefthook install\n" +
        "  npm install --save-dev lefthook",
    );
  }
}

export async function initProject(root: string, force = false): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], notes: [] };
  const configPath = path.join(root, "product-lint.config.json");
  const template = fileURLToPath(new URL("../templates/product-lint.config.json", import.meta.url));
  if ((await exists(configPath)) && !force) {
    result.skipped.push(configPath);
  } else {
    await mkdir(root, { recursive: true });
    await copyFile(template, configPath);
    result.created.push(configPath);
  }

  // Git cannot track empty directories, so each level carries a .gitkeep and
  // survives a clone.
  for (const level of KNOWLEDGE_DIRECTORIES) {
    const directory = path.join(root, "docs", level);
    await mkdir(directory, { recursive: true });
    result.created.push(directory);
    const keep = path.join(directory, ".gitkeep");
    if (await exists(keep)) {
      result.skipped.push(keep);
    } else {
      await writeFile(keep, "", "utf8");
      result.created.push(keep);
    }
  }

  const gitignore = path.join(root, ".gitignore");
  if (!(await exists(gitignore))) {
    await writeFile(gitignore, "node_modules/\ndist/\n", "utf8");
    result.created.push(gitignore);
  }

  await configureLefthook(root, result);

  if (!(await exists(path.join(root, ".git")))) {
    result.notes.push("No .git directory found. Run: git init, then: npx lefthook install");
    return result;
  }

  await installLefthookHooks(root, result);
  return result;
}
