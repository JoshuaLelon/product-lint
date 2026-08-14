import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { loadConfig, synchronizeStaged } from "../dist/index.js";

export async function run(root, command, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr}`));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export async function git(root, ...args) {
  return run(root, "git", args);
}

export function canonicalNodes() {
  return [
    {
      id: "audience.role.reviewer",
      level: "audience",
      statement: "The product serves people who review video shots.",
      constrainedBy: [],
      sync: { constraintsDigest: "pending" },
    },
    {
      id: "context.review-problem",
      level: "context",
      statement: "Video teams lose track of review state.",
      constrainedBy: ["audience.role.reviewer"],
      sync: { constraintsDigest: "pending" },
    },
    {
      id: "product.current-version",
      level: "product",
      statement: "Each shot has one current version.",
      constrainedBy: ["context.review-problem"],
      sync: { constraintsDigest: "pending" },
    },
    {
      id: "behavior.approve-version",
      level: "behavior",
      statement: "A reviewer can approve the current version.",
      constrainedBy: ["product.current-version"],
      sync: { constraintsDigest: "pending" },
    },
    {
      id: "architecture.approval-owner",
      level: "architecture",
      statement: "The application layer owns approval transitions.",
      constrainedBy: ["behavior.approve-version"],
      sync: { constraintsDigest: "pending" },
    },
    {
      id: "mechanism.approval-command",
      level: "mechanism",
      statement: "Approval is implemented by an application command.",
      constrainedBy: ["architecture.approval-owner"],
      sync: { constraintsDigest: "pending" },
      implementation: {
        files: ["src/approve.ts", "test/approve.test.ts"],
        digest: "pending",
      },
    },
  ];
}

export async function writeNode(root, node) {
  const name = node.id.slice(node.id.indexOf(".") + 1).replaceAll(".", "-");
  const file = path.join(root, "docs", node.level, `${name}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ schemaVersion: 1, ...node }, null, 2)}\n`, "utf8");
  return file;
}

export async function createRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "product-lint-test-"));
  await git(root, "init", "-q");
  await git(root, "config", "user.email", "test@example.com");
  await git(root, "config", "user.name", "Product Lint Test");
  await writeFile(
    path.join(root, "product-lint.config.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      root: ".",
      knowledgeRoot: "docs",
      governedPaths: {
        include: ["src/**", "test/**"],
        exclude: ["docs/**", "node_modules/**", "dist/**"],
      },
      commit: { trailer: "Knowledge-Change", requireBody: true },
    }, null, 2)}\n`,
  );
  await mkdir(path.join(root, "src"), { recursive: true });
  await mkdir(path.join(root, "test"), { recursive: true });
  await writeFile(path.join(root, "src", "approve.ts"), "export const approve = () => true;\n");
  await writeFile(path.join(root, "test", "approve.test.ts"), "// approval test\n");
  for (const node of canonicalNodes()) await writeNode(root, node);
  await git(root, "add", ".");
  const config = await loadConfig(root);
  const sync = await synchronizeStaged(config);
  if (sync.diagnostics.length > 0) throw new Error(JSON.stringify(sync.diagnostics));
  await git(root, "add", "docs");
  await git(root, "commit", "-qm", "chore: seed product knowledge");
  return { root, config: await loadConfig(root) };
}

export async function readNode(root, level, name) {
  return JSON.parse(await readFile(path.join(root, "docs", level, `${name}.json`), "utf8"));
}

// `rejected` is required on a term, and a fixture that says nothing about
// naming alternatives means none were weighed — so the empty list is the
// default here. Tests that exercise the field pass their own.
export async function writeTerm(root, term) {
  const slug = term.id.slice("term.".length).replaceAll(".", "-");
  const file = path.join(root, "docs", term.level, "terms", `${slug}.json`);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    `${JSON.stringify({ schemaVersion: 1, rejected: [], ...term }, null, 2)}\n`,
    "utf8",
  );
  return file;
}

export async function readTerm(root, level, slug) {
  return JSON.parse(await readFile(path.join(root, "docs", level, "terms", `${slug}.json`), "utf8"));
}
