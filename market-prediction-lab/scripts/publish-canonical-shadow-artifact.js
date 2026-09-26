#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { publishShadowArtifactToStateRootV1 } from "../src/shadow-state-root-transport-v1.js";

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error("Arguments must be --name value pairs");
    values.set(key.slice(2), value);
  }
  return values;
}

function required(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function publishCanonicalShadowArtifactCliV1(argv = process.argv.slice(2)) {
  const values = parseArgs(argv);
  const artifactRoot = resolve(required(values, "artifact-root"));
  const metadataPath = resolve(required(values, "metadata"));
  const stateRoot = resolve(required(values, "state-root"));
  const resultPath = resolve(required(values, "result"));
  const asOf = values.get("as-of") ?? new Date().toISOString();
  const artifactMetadata = JSON.parse(await readFile(metadataPath, "utf8"));
  const result = await publishShadowArtifactToStateRootV1({ artifactRoot, artifactMetadata, stateRoot, asOf });
  const stateSha256 = await sha256File(result.statePath);
  const safe = Object.freeze({
    schemaVersion: "prediction-lab-canonical-shadow-publication-result-v1",
    status: result.status,
    wrote: result.wrote,
    statePath: result.statePath,
    stateSha256,
    sourceRunId: result.publication.sourceRunId,
    artifactId: result.publication.artifactId,
    sourceArtifactDigest: result.publication.shadowArtifactDigest,
    producerRunId: result.publication.producerRunId,
    predecessorShadowRunId: result.publication.predecessorShadowRunId,
    researchCodeSha: result.publication.researchCodeSha,
    observationCount: result.publication.observationCount,
    settledObservationCount: result.publication.settledObservationCount,
    missingEvidenceReasons: result.publication.missingEvidenceReasons,
    PROFITABILITY_PROVEN: result.publication.PROFITABILITY_PROVEN,
    FORWARD_EVIDENCE_SUFFICIENT: result.publication.FORWARD_EVIDENCE_SUFFICIENT,
    safety: result.safety,
  });
  await writeFile(resultPath, `${JSON.stringify(safe, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  process.stdout.write(`${JSON.stringify(safe)}\n`);
  return safe;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  publishCanonicalShadowArtifactCliV1().catch((error) => {
    console.error(String(error?.message ?? error).slice(0, 400));
    process.exitCode = 1;
  });
}
