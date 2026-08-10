// The spectrum, the ratchet, and the review record.
//
// The property under test throughout is that an unmeasured band is never a
// clean one. A count that was never taken and a count that came back zero are
// different facts, and collapsing them is how a tool reports success over work
// it did not look at.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  BAND_DEPENDENCIES,
  acceptBaseline,
  bandByName,
  baselineFrom,
  compareToBaseline,
  inspectWorkingTree,
  loadConfig,
} from "../dist/index.js";
import { createRepository, writeNode, git } from "./_helpers.mjs";

async function spectrumOf(root) {
  const config = await loadConfig(root);
  return (await inspectWorkingTree(config)).spectrum;
}

test("band order is a topological order of the dependency table", () => {
  const seen = new Set();
  for (const [name, dependencies] of Object.entries(BAND_DEPENDENCIES)) {
    for (const dependency of dependencies) {
      assert.ok(
        seen.has(dependency),
        `${name} depends on ${dependency}, which must be measured first`,
      );
    }
    seen.add(name);
  }
});

test("a clean repository measures every band", async () => {
  const { root } = await createRepository();
  const spectrum = await spectrumOf(root);
  for (const band of spectrum.bands) {
    assert.equal(band.state.kind, "clean", `${band.name} should be clean: ${band.state.kind}`);
  }
});

test("a band that cannot be measured is masked, never zero", async () => {
  const { root } = await createRepository();
  // A cycle stops the graph from building at all, so nothing downstream of
  // STRUCTURE was ever looked at.
  await writeNode(root, {
    id: "mechanism.approval-command",
    level: "mechanism",
    statement: "Approval is implemented by an application command.",
    constrainedBy: ["architecture.approval-owner", "mechanism.approval-command"],
    sync: { constraintsDigest: "pending" },
    implementation: { files: ["src/approve.ts"], digest: "pending" },
  });
  const spectrum = await spectrumOf(root);

  assert.equal(bandByName(spectrum, "STRUCTURE").state.kind, "measured");
  for (const name of ["COVERAGE", "OVERLAP"]) {
    const band = bandByName(spectrum, name);
    assert.equal(band.state.kind, "masked", `${name} must not report a number`);
    assert.deepEqual(band.state.by, { band: "STRUCTURE" });
    // The distinction the whole type exists for.
    assert.equal(band.state.residual, undefined);
    assert.deepEqual(band.findings, []);
  }
});

test("a measured band's residual is exactly its finding count", async () => {
  const { root } = await createRepository();
  await mkdir(path.join(root, "src/extra"), { recursive: true });
  for (const name of ["a.ts", "b.ts", "c.ts"]) {
    await writeFile(path.join(root, "src/extra", name), "// unowned\n");
  }
  const spectrum = await spectrumOf(root);
  const coverage = bandByName(spectrum, "COVERAGE");
  assert.equal(coverage.state.kind, "measured");
  assert.equal(coverage.state.residual, 3);
  assert.equal(coverage.state.residual, coverage.findings.length);
});

test("the ratchet reports a rise and stays silent on a fall", async () => {
  const { root } = await createRepository();
  const clean = await spectrumOf(root);
  const baseline = baselineFrom(clean, "seeded");

  await mkdir(path.join(root, "src/extra"), { recursive: true });
  await writeFile(path.join(root, "src/extra/a.ts"), "// unowned\n");
  const worse = await spectrumOf(root);

  const rise = compareToBaseline(worse, baseline);
  const regression = rise.find((item) => item.code === "PL0901 BAND_REGRESSION");
  assert.ok(regression, "a rise must be reported");
  assert.equal(regression.severity, "error");
  assert.equal(regression.details.baseline, 0);
  assert.equal(regression.details.current, 1);

  const fall = compareToBaseline(clean, baselineFrom(worse, "seeded"));
  const improved = fall.find((item) => item.code === "PL0905 BAND_IMPROVED");
  assert.ok(improved, "a fall must be reported as an improvement");
  assert.equal(improved.severity, "info");
  assert.equal(fall.some((item) => item.severity === "error"), false);
});

test("a band that becomes measurable is not a regression from zero", async () => {
  const { root } = await createRepository();
  const spectrum = await spectrumOf(root);
  const masked = {
    schemaVersion: 1,
    reason: "seeded",
    bands: { STRUCTURE: { state: "clean" }, COVERAGE: { state: "masked" }, OVERLAP: { state: "clean" } },
    digest: "sha256:test",
  };
  const diagnostics = compareToBaseline(spectrum, masked);
  assert.equal(diagnostics.some((item) => item.code === "PL0901 BAND_REGRESSION"), false);
  const now = diagnostics.find((item) => item.code === "PL0903 BAND_NOW_MEASURABLE");
  assert.ok(now);
  assert.equal(now.severity, "info");
});

test("the commit path stays silent when no floor was ever recorded", async () => {
  const { root } = await createRepository();
  const spectrum = await spectrumOf(root);
  assert.deepEqual(compareToBaseline(spectrum, undefined), []);
  const announced = compareToBaseline(spectrum, undefined, { announceMissing: true });
  assert.equal(announced[0].code, "PL0902 MISSING_BASELINE");
});

test("accept refuses without a reason and on a dirty tree", async () => {
  const { root, config } = await createRepository();
  const noReason = await acceptBaseline(config, {});
  assert.equal(noReason.diagnostics[0].code, "PL0906 UNEXPLAINED_ACCEPT");
  assert.equal(noReason.written, undefined);

  await writeFile(path.join(root, "src/dirty.ts"), "// uncommitted\n");
  const dirty = await acceptBaseline(config, { reason: "trying anyway" });
  assert.equal(dirty.diagnostics[0].code, "PL0907 DIRTY_ACCEPT_TREE");
  assert.equal(dirty.written, undefined);
});

test("accept records a floor, and raising it needs the flag", async () => {
  const { root, config } = await createRepository();
  const first = await acceptBaseline(config, { reason: "initial floor" });
  assert.deepEqual(first.diagnostics, []);
  assert.equal(first.written, ".product-lint/baseline.json");
  assert.equal(first.baseline.reason, "initial floor");

  await mkdir(path.join(root, "src/extra"), { recursive: true });
  await writeFile(path.join(root, "src/extra/a.ts"), "// unowned\n");
  await git(root, "add", ".");
  await git(root, "commit", "-qm", "add an unowned file");

  const raise = await acceptBaseline(config, { reason: "widened scope" });
  assert.equal(raise.diagnostics[0].code, "PL0908 UNDECLARED_RAISE");
  assert.equal(raise.written, undefined);

  const declared = await acceptBaseline(config, {
    reason: "widened scope",
    allowRegression: true,
  });
  assert.deepEqual(declared.diagnostics, []);
  assert.equal(declared.baseline.bands.COVERAGE.residual, 1);
});

test("the spectrum is a fixed-length vector in a stable order", async () => {
  const { root } = await createRepository();
  const spectrum = await spectrumOf(root);
  // A consumer reads bands positionally and by name. Both must hold, or a
  // shorter vector could read as "the missing ones were clean".
  assert.deepEqual(
    spectrum.bands.map((band) => band.name),
    Object.keys(BAND_DEPENDENCIES),
  );
});
