import path from "node:path";
import { execFile } from "node:child_process";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
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

  // A hook this file already defines cannot be appended to, because a duplicate
  // top-level key is not merged — the second one wins and the project's own jobs
  // would be lost. So each hook is either appended whole or handed back as a
  // manual step, and the two decisions are INDEPENDENT. They used to share one
  // branch: the manual note was printed only when BOTH hooks already existed, so
  // a project with a pre-commit block and no commit-msg block got the commit-msg
  // block appended, got no note, and never learned that its pre-commit commands
  // were never wired. init then printed a success list over a half-install.
  const hooks: Array<{ present: boolean; block: string; manual: string[] }> = [
    {
      present: /^pre-commit:/m.test(current),
      block: PRE_COMMIT_BLOCK,
      manual: [
        "  pre-commit:  npx product-lint knowledge sync --staged && git add docs/",
        "  pre-commit:  npx product-lint commit check --staged",
      ],
    },
    {
      present: /^commit-msg:/m.test(current),
      block: COMMIT_MSG_BLOCK,
      manual: ["  commit-msg:  npx product-lint commit message {1}"],
    },
  ];

  const additions = hooks.filter((hook) => !hook.present).map((hook) => hook.block);
  const manual = hooks.filter((hook) => hook.present).flatMap((hook) => hook.manual);

  if (additions.length > 0) {
    const separator = current.endsWith("\n") ? "\n" : "\n\n";
    await writeFile(target, `${current}${separator}${additions.join("\n")}`, "utf8");
    result.created.push(`${target} (appended)`);
  } else {
    result.skipped.push(target);
  }

  if (manual.length > 0) {
    result.notes.push(
      `${path.basename(target)} already defines these hooks, so Product Lint did not touch them.\n` +
        `NOT INSTALLED until you add these commands yourself:\n${manual.join("\n")}`,
    );
  }
}

/**
 * Hooks are worthless until they are installed into .git/hooks, so do it here
 * rather than leaving it as a step the user has to remember.
 */
async function installLefthookHooks(root: string, result: InitResult): Promise<void> {
  try {
    await run("npx", ["--no-install", "lefthook", "install"], { cwd: root });
    result.notes.push("Installed Git hooks via lefthook.");
    return;
  } catch (error) {
    // Never replace lefthook's own words with a guess. This used to report every
    // failure as "install lefthook", which is a WRONG DIAGNOSIS in the common
    // case: a repository with core.hooksPath set already has lefthook, and
    // lefthook refuses that path and prints the exact flag that fixes it. A tool
    // that tells every diagnostic to name its repair may not throw away the one
    // repair it was handed.
    const detail = [
      (error as { stderr?: string }).stderr,
      (error as { stdout?: string }).stdout,
    ]
      .filter((stream): stream is string => Boolean(stream?.trim()))
      .join("\n")
      .trim();

    const lines = ["Could not install the Git hooks. lefthook said:"];
    lines.push(detail ? detail : String(error));
    if (/hooksPath/i.test(detail)) {
      lines.push(
        "This repository sets core.hooksPath, so lefthook will not install without being told to.",
        "Run: npx lefthook install --force",
      );
    } else {
      lines.push("If lefthook is missing, run: npm install --save-dev lefthook");
    }
    lines.push("The hooks are NOT installed until that command succeeds.");
    result.notes.push(lines.join("\n"));
  }
}

/**
 * A hook block in lefthook.yml does nothing until a hook script exists in the
 * repository's hooks path. Both halves failed independently on a real install:
 * the block was written, the script was missing, and init printed a success
 * list over a hook that could never fire.
 */
async function verifyHookScripts(root: string, result: InitResult): Promise<void> {
  let hooksPath = ".git/hooks";
  try {
    const { stdout } = await run("git", ["config", "--get", "core.hooksPath"], { cwd: root });
    if (stdout.trim()) hooksPath = stdout.trim();
  } catch {
    // Unset is the normal case, and the default above already covers it.
  }

  const missing: string[] = [];
  for (const hook of ["pre-commit", "commit-msg"]) {
    if (!(await exists(path.resolve(root, hooksPath, hook)))) missing.push(hook);
  }
  if (missing.length > 0) {
    result.notes.push(
      `No hook script at ${hooksPath}/{${missing.join(",")}}, so ${missing.length === 1 ? "that hook" : "those hooks"} cannot run.\n` +
        "Run: npx lefthook install --force",
    );
  }
}

const INSTALLED_SCHEMA = "./node_modules/product-lint/schema";

/**
 * Where a `$schema` reference should point, from this repository's root.
 *
 * The template assumes an installed copy, which is right for `npm i -D
 * product-lint` and wrong everywhere else. A repository that vendors the
 * package, or hosts Product Lint itself, gets a path resolving to nothing — so
 * every editor honouring `$schema` reports the config as unvalidatable, which
 * is the same failure as shipping no schema at all.
 *
 * Installed first, because that is what an editor resolves once the dependency
 * is in place even when this command is running from somewhere else. Then the
 * running package if it sits inside the repository. Then the template's
 * assumption, which is the honest guess for a global or npx run: the package is
 * outside the tree, and a relative path out of it would be worse than a path
 * the user's next install makes true.
 */
export async function schemaReference(root: string, packageRoot: string): Promise<string> {
  if (await exists(path.join(root, "node_modules", "product-lint", "schema"))) {
    return INSTALLED_SCHEMA;
  }
  const own = path.join(packageRoot, "schema");
  const relative = path.relative(root, own);
  if ((await exists(own)) && relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return `./${relative.split(path.sep).join("/")}`;
  }
  return INSTALLED_SCHEMA;
}

export async function initProject(root: string, force = false): Promise<InitResult> {
  const result: InitResult = { created: [], skipped: [], notes: [] };
  const configPath = path.join(root, "product-lint.config.json");
  const template = fileURLToPath(new URL("../templates/product-lint.config.json", import.meta.url));
  const packageRoot = fileURLToPath(new URL("..", import.meta.url));
  if ((await exists(configPath)) && !force) {
    result.skipped.push(configPath);
  } else {
    await mkdir(root, { recursive: true });
    const schema = await schemaReference(root, packageRoot);
    const text = await readFile(template, "utf8");
    await writeFile(
      configPath,
      text.replace(`${INSTALLED_SCHEMA}/config.schema.json`, `${schema}/config.schema.json`),
      "utf8",
    );
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
  await verifyHookScripts(root, result);
  return result;
}
