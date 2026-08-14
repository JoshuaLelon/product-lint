import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtemp, mkdir, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { schemaReference } from "../dist/index.js";
import { canonicalNodes, createRepository, writeNode } from "./_helpers.mjs";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

/**
 * `_helpers.run` rejects on a non-zero exit, and the exit code is the thing
 * under test here, so this resolves with it instead.
 */
function cli(root, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * No `.git`, so `initProject` returns before it shells out to lefthook. The
 * compliance check runs either way, and the test stays hermetic and fast.
 */
async function bareDirectory() {
  return mkdtemp(path.join(tmpdir(), "product-lint-init-"));
}

async function exists(entry) {
  try {
    await stat(entry);
    return true;
  } catch {
    return false;
  }
}

test("init provisions and then reports the empty graph, rather than only provisioning", async () => {
  const root = await bareDirectory();
  const { code, stdout } = await cli(root, ["init"]);

  // Provisioning still happened.
  assert.ok(await exists(path.join(root, "product-lint.config.json")));
  assert.ok(await exists(path.join(root, "docs", "context", ".gitkeep")));
  assert.match(stdout, /created .*product-lint\.config\.json/);

  // And the check ran on what it just wrote.
  assert.match(stdout, /PL0011 MISSING_AUDIENCE/);
  assert.equal(code, 2, "an empty graph is incomplete, not invalid");
});

test("init labels the compliance output so it does not read as a provisioning failure", async () => {
  const root = await bareDirectory();
  const { stdout } = await cli(root, ["init"]);
  const boundary = stdout.indexOf("provisioning done");
  assert.ok(boundary > 0, "the two phases are separated by name");
  assert.ok(
    stdout.lastIndexOf("created ") < boundary,
    "every created path is printed before the boundary",
  );
  assert.ok(
    stdout.indexOf("PL0011") > boundary,
    "every diagnostic is printed after the boundary",
  );
});

test("init exits 0 on a repository whose graph is already complete", async () => {
  const { root } = await createRepository();
  const { code, stdout } = await cli(root, ["init"]);
  assert.match(stdout, /no diagnostics/);
  assert.equal(code, 0);
});

test("init and check agree on the state of the same working tree", async () => {
  // The whole reason both commands read through one `statusReport`. An init that
  // disagreed with the check it tells you to run would make both untrustworthy.
  const { root } = await createRepository();
  for (const state of ["complete", "broken"]) {
    if (state === "broken") {
      await writeNode(root, {
        id: "product.orphan",
        level: "product",
        statement: "This node names a parent that does not exist.",
        constrainedBy: ["context.absent"],
        sync: { constraintsDigest: "pending" },
      });
    }
    const init = await cli(root, ["init"]);
    const check = await cli(root, ["check"]);
    assert.equal(init.code, check.code, `init and check disagree while ${state}`);
  }
});

test("init reports an invalid graph as 1, outranking an incomplete one", async () => {
  const root = await bareDirectory();
  await cli(root, ["init"]);
  await mkdir(path.join(root, "docs", "context"), { recursive: true });
  await writeFile(path.join(root, "docs", "context", "broken.json"), "{ not json\n", "utf8");
  const { code, stdout } = await cli(root, ["init"]);
  assert.match(stdout, /PL10/, "a parse failure is reported");
  assert.equal(code, 1, "an invalid graph is an error, not an incomplete frontier");
});

test("init --json carries the check beside what it provisioned", async () => {
  const root = await bareDirectory();
  const { stdout, code } = await cli(root, ["init", "--json"]);
  const result = JSON.parse(stdout);
  assert.ok(Array.isArray(result.created));
  assert.equal(result.check.complete, false);
  assert.ok(
    result.check.diagnostics.some((item) => item.code.startsWith("PL0011")),
    "the JSON view carries the same diagnostic the text view prints",
  );
  // The annotations agents rely on survive the JSON path.
  const missing = result.check.diagnostics.find((item) => item.code.startsWith("PL0011"));
  assert.ok(missing.fix, "diagnostics are annotated with their repair");
  assert.ok(missing.shape, "a diagnostic that adds a node carries the shape rule");
  assert.equal(code, 2);
});

test("init on a graph that stops early reports the next level, not the first", async () => {
  // Truncate the seeded repository below Product. Context and Product keep their
  // synchronized digests, because a digest hashes a node's parents and neither
  // has a deleted one — so what is left is a clean graph that simply stops.
  const { root } = await createRepository();
  for (const node of canonicalNodes().slice(3)) {
    const name = node.id.slice(node.id.indexOf(".") + 1).replaceAll(".", "-");
    await rm(path.join(root, "docs", node.level, `${name}.json`));
  }
  await rm(path.join(root, "src"), { recursive: true });
  await rm(path.join(root, "test"), { recursive: true });

  const { code, stdout } = await cli(root, ["init"]);
  assert.doesNotMatch(stdout, /MISSING_AUDIENCE/, "the audience level exists now");
  assert.match(stdout, /MISSING_BEHAVIOR/, "the frontier moved down to the next absent level");
  assert.equal(code, 2, "a graph that stops early is incomplete, not invalid");
});

test("the config's $schema points at a schema that exists, installed or not", async () => {
  const root = await bareDirectory();
  const packageRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));

  // A repository that vendors the package, or hosts Product Lint itself, gets a
  // path relative to its own root. The template's node_modules guess resolves to
  // nothing there, so every editor honouring $schema reports the config as
  // unvalidatable — the same failure as shipping no schema at all.
  const inside = await schemaReference(packageRoot, packageRoot);
  assert.equal(inside, "./schema");

  // Outside the tree — a global or npx run — the template's assumption is the
  // honest guess: a relative path climbing out of the repository would be worse
  // than one the user's next install makes true.
  assert.equal(await schemaReference(root, packageRoot), "./node_modules/product-lint/schema");

  // And an installed copy wins over the running one, because that is what an
  // editor resolves once the dependency is in place.
  await mkdir(path.join(root, "node_modules", "product-lint", "schema"), { recursive: true });
  assert.equal(await schemaReference(root, packageRoot), "./node_modules/product-lint/schema");

  const { stdout } = await cli(root, ["init"]);
  assert.ok(stdout.includes("product-lint.config.json"));
});
