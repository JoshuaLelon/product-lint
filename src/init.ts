import path from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export interface InitResult {
  created: string[];
  skipped: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await readFile(file);
    return true;
  } catch {
    return false;
  }
}

export async function initProject(root: string, force = false): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  const configPath = path.join(root, "product-lint.config.json");
  const template = fileURLToPath(new URL("../templates/product-lint.config.json", import.meta.url));
  if ((await exists(configPath)) && !force) {
    skipped.push(configPath);
  } else {
    await mkdir(root, { recursive: true });
    await copyFile(template, configPath);
    created.push(configPath);
  }

  for (const level of ["context", "product", "behavior", "architecture", "mechanism", "reference"]) {
    const directory = path.join(root, "docs", level);
    await mkdir(directory, { recursive: true });
    created.push(directory);
  }

  const gitignore = path.join(root, ".gitignore");
  if (!(await exists(gitignore))) {
    await writeFile(gitignore, "node_modules/\ndist/\n", "utf8");
    created.push(gitignore);
  }

  return { created, skipped };
}
