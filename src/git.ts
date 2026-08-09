import { spawn } from "node:child_process";
import path from "node:path";
import type { GitChange, GitChangeStatus } from "./types.js";
import { normalizePath } from "./glob.js";

interface CommandResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
}

async function runGit(
  root: string,
  args: string[],
  options: { allowFailure?: boolean } = {},
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      };
      if (result.code !== 0 && !options.allowFailure) {
        reject(
          new Error(
            `git ${args.join(" ")} failed (${result.code}): ${result.stderr.toString("utf8").trim()}`,
          ),
        );
        return;
      }
      resolve(result);
    });
  });
}

export async function ensureGitRepository(root: string): Promise<void> {
  const result = await runGit(root, ["rev-parse", "--is-inside-work-tree"], { allowFailure: true });
  if (result.code !== 0 || result.stdout.toString("utf8").trim() !== "true") {
    throw new Error(`Product Lint requires a Git repository: ${root}`);
  }
}

export async function listIndexFiles(root: string): Promise<string[]> {
  const result = await runGit(root, ["ls-files", "-z", "--cached"]);
  return result.stdout
    .toString("utf8")
    .split("\0")
    .map((item: string) => normalizePath(item))
    .filter(Boolean)
    .sort();
}

export async function listHeadFiles(root: string): Promise<string[]> {
  const result = await runGit(root, ["ls-tree", "-r", "-z", "--name-only", "HEAD"], {
    allowFailure: true,
  });
  if (result.code !== 0) return [];
  return result.stdout
    .toString("utf8")
    .split("\0")
    .map((item: string) => normalizePath(item))
    .filter(Boolean)
    .sort();
}

export async function readIndexFile(root: string, file: string): Promise<string> {
  const result = await runGit(root, ["show", `:${normalizePath(file)}`]);
  return result.stdout.toString("utf8");
}

export async function readHeadFile(root: string, file: string): Promise<string> {
  const result = await runGit(root, ["show", `HEAD:${normalizePath(file)}`]);
  return result.stdout.toString("utf8");
}

export async function stagedChanges(root: string): Promise<GitChange[]> {
  const result = await runGit(root, ["diff", "--cached", "--name-status", "-z", "-M"]);
  const parts = result.stdout.toString("utf8").split("\0").filter(Boolean);
  const changes: GitChange[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    const token = parts[index] ?? "";
    const statusText = token[0] ?? "X";
    const status = statusText as GitChangeStatus;
    if (status === "R" || status === "C") {
      const oldPath = normalizePath(parts[index + 1] ?? "");
      const newPath = normalizePath(parts[index + 2] ?? "");
      changes.push({ status, oldPath, path: newPath });
      index += 2;
    } else {
      const file = normalizePath(parts[index + 1] ?? "");
      changes.push({ status, path: file });
      index += 1;
    }
  }
  return changes;
}

export async function hasUnstagedChanges(root: string, file: string): Promise<boolean> {
  const result = await runGit(root, ["diff", "--quiet", "--", normalizePath(file)], {
    allowFailure: true,
  });
  return result.code !== 0;
}

export async function commitExists(root: string, commit: string): Promise<boolean> {
  const result = await runGit(root, ["cat-file", "-e", `${commit}^{commit}`], { allowFailure: true });
  return result.code === 0;
}

export async function fileExistsAtCommit(
  root: string,
  commit: string,
  file: string,
): Promise<boolean> {
  const result = await runGit(root, ["cat-file", "-e", `${commit}:${normalizePath(file)}`], {
    allowFailure: true,
  });
  return result.code === 0;
}

export async function isWorkingTreeDirty(root: string): Promise<boolean> {
  const result = await runGit(root, ["status", "--porcelain"]);
  return result.stdout.length > 0;
}

export function absolutePath(root: string, relative: string): string {
  return path.resolve(root, relative);
}
