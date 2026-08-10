// Reviewing a level, recorded as a fact.
//
// The tool never learns what the reviewer concluded. It knows only whether
// somebody looked at this text, which is decidable, where "do these two
// statements overlap" is not.

import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  attestationDiagnostics,
  cohortDigest,
  cohortsOf,
  createSnapshot,
  loadAttestations,
  loadConfig,
  validateSnapshot,
} from "../dist/index.js";
import { createRepository, writeNode } from "./_helpers.mjs";

async function withBehaviorSiblings(root) {
  for (const [id, statement] of [
    ["behavior.reject-version", "A reviewer can reject the current version."],
    ["behavior.comment-version", "A reviewer can comment on the current version."],
  ]) {
    await writeNode(root, {
      id,
      level: "behavior",
      statement,
      constrainedBy: ["product.current-version"],
      sync: { constraintsDigest: "pending" },
    });
  }
}

async function attestFor(root, levels) {
  const config = await loadConfig(root);
  const resolved = { ...config, attest: { levels } };
  const snapshot = await createSnapshot(resolved, "working");
  const { graph } = await validateSnapshot(resolved, snapshot);
  const loaded = await loadAttestations(resolved, snapshot);
  return {
    graph,
    config: resolved,
    diagnostics: [
      ...loaded.diagnostics,
      ...attestationDiagnostics(resolved, graph, loaded.attestations),
    ],
  };
}

async function writeAttestation(root, attestation) {
  await mkdir(path.join(root, "docs/attest"), { recursive: true });
  const name = attestation.cohort.replace(/[/.]/g, "-");
  await writeFile(
    path.join(root, "docs/attest", `${name}.json`),
    `${JSON.stringify(attestation, null, 2)}\n`,
    "utf8",
  );
}

test("an empty level list turns attestation off", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  const { diagnostics } = await attestFor(root, []);
  assert.deepEqual(diagnostics, []);
});

test("the levels with no other detector are asked by default", async () => {
  const { root } = await createRepository();
  const config = await loadConfig(root);
  // Mechanism is absent on purpose: PL0603 already decides the part of it that
  // files can settle, and its cohorts are the largest.
  assert.deepEqual(config.attest.levels, ["product", "behavior", "architecture"]);
});

test("an unreviewed level does not block a commit, and does block a ship", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  const { diagnostics } = await attestFor(root, ["behavior"]);
  // Severity is info at the source. `ship` raises it, and nothing else does,
  // because a commit gate on an open question is what teaches --no-verify.
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].severity, "info");
});

test("an opted-in cohort with no review is reported once", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  const { diagnostics } = await attestFor(root, ["behavior"]);
  const unreviewed = diagnostics.filter((item) => item.code === "PL0802 UNREVIEWED_COHORT");
  assert.equal(unreviewed.length, 1);
  assert.equal(unreviewed[0].severity, "info");
  assert.deepEqual(unreviewed[0].details.members, [
    "behavior.approve-version",
    "behavior.comment-version",
    "behavior.reject-version",
  ]);
});

test("a cohort of one is never asked about", async () => {
  const { root } = await createRepository();
  // The seeded graph is a chain, so every cohort has exactly one member.
  const { diagnostics } = await attestFor(root, ["behavior", "architecture", "mechanism"]);
  assert.deepEqual(diagnostics, []);
});

test("a recorded review satisfies the cohort until the text changes", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  const { graph } = await attestFor(root, ["behavior"]);
  const cohort = cohortsOf(graph).find((item) => item.level === "behavior");
  await writeAttestation(root, {
    schemaVersion: 1,
    cohort: `${cohort.parentId}/behavior`,
    digest: cohortDigest(graph, cohort),
    reviewedFor: ["exclusive", "exhaustive"],
    note: "Approve, reject, and comment are the three transitions the product rule permits.",
  });

  const reviewed = await attestFor(root, ["behavior"]);
  assert.deepEqual(reviewed.diagnostics, []);

  // Adding a fourth sibling is exactly the moment the review stops covering the
  // set, because the question it answered was about the set.
  await writeNode(root, {
    id: "behavior.reopen-version",
    level: "behavior",
    statement: "A reviewer can reopen an approved version.",
    constrainedBy: ["product.current-version"],
    sync: { constraintsDigest: "pending" },
  });
  const stale = await attestFor(root, ["behavior"]);
  const found = stale.diagnostics.filter((item) => item.code === "PL0803 STALE_COHORT_ATTESTATION");
  assert.equal(found.length, 1);
  assert.ok(found[0].details.currentDigest);
  assert.notEqual(found[0].details.reviewedDigest, found[0].details.currentDigest);
});

test("the review asks for the rule about a set, not about a sentence", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  const { diagnostics } = await attestFor(root, ["behavior"]);
  const { annotateDiagnostic } = await import("../dist/index.js");
  const annotated = annotateDiagnostic(diagnostics[0]);
  assert.match(annotated.shape, /do not overlap/);
  assert.match(annotated.style, /Simplified Technical English/);
});

test("a review with no note is not a review", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  await writeAttestation(root, {
    cohort: "product.current-version/behavior",
    digest: "sha256:whatever",
    note: "   ",
  });
  const { diagnostics } = await attestFor(root, ["behavior"]);
  assert.equal(diagnostics[0].code, "PL0801 INVALID_ATTESTATION");
  assert.equal(diagnostics[0].severity, "error");
});

test("a review of a cohort that no longer exists describes nothing", async () => {
  const { root } = await createRepository();
  await withBehaviorSiblings(root);
  await writeAttestation(root, {
    cohort: "product.deleted-rule/behavior",
    digest: "sha256:whatever",
    note: "These divide by transition.",
  });
  const { diagnostics } = await attestFor(root, ["behavior"]);
  const orphan = diagnostics.find((item) => item.code === "PL0804 ORPHANED_ATTESTATION");
  assert.ok(orphan);
});
