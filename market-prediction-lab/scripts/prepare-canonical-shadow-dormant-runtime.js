#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  buildCanonicalShadowCutoverPlanV1,
  selectCanonicalPredecessorBindingV1,
  selectCanonicalProducerBindingV1,
} from "../src/canonical-shadow-runtime-cutover-v1.js";

function args(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    if (!argv[index]?.startsWith("--") || argv[index + 1] == null) throw new Error("Arguments must be --name value pairs");
    values.set(argv[index].slice(2), argv[index + 1]);
  }
  return values;
}

const values = args(process.argv.slice(2));
const inventoryPath = values.get("inventory");
if (!inventoryPath || values.get("dry-run") !== "true") {
  throw new Error("Dormant runtime preparation requires --inventory <json> --dry-run true");
}
for (const forbidden of ["state-root", "publish", "activate-schedule", "cutover-enabled"]) {
  if (values.has(forbidden)) throw new Error(`Dormant runtime preparation forbids --${forbidden}`);
}

const inventory = JSON.parse(await readFile(resolve(inventoryPath), "utf8"));
const producer = selectCanonicalProducerBindingV1(inventory.producerCandidates, { asOf: inventory.asOf });
const predecessor = selectCanonicalPredecessorBindingV1({
  candidates: inventory.predecessorCandidates,
  producer,
  researchSha: inventory.researchSha,
  strategyIdentityDigest: producer.strategyIdentityDigest,
  modelIdentityDigest: producer.modelIdentityDigest,
  asOf: inventory.asOf,
  isResearchAncestor: (ancestor, head) => inventory.researchAncestors?.[head]?.includes(ancestor) === true,
});
const plan = buildCanonicalShadowCutoverPlanV1({ researchSha: inventory.researchSha, producer, predecessor });

process.stdout.write(`${JSON.stringify({
  schemaVersion: "prediction-lab-canonical-shadow-dormant-runtime-plan-v1",
  mode: "DRY_RUN_ONLY",
  producer,
  predecessor: {
    runId: predecessor.runId,
    artifact: predecessor.artifact,
    pendingSettlementCount: Number(predecessor.pendingSettlementCount ?? 0),
  },
  plan,
  atomicPublishCandidate: {
    validatedPublicationManifestRequired: true,
    target: plan.stateRootRelativePath,
    execute: false,
  },
  cutoverExecuted: false,
  stateRootMutation: 0,
}, null, 2)}\n`);
