#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import {
  publishShadowArtifactToStateRootV1,
  ShadowStateRootTransportError,
} from "../src/shadow-state-root-transport-v1.js";

function argumentsFrom(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value == null) throw new Error("Arguments must be --name value pairs");
    values.set(key.slice(2), value);
  }
  return values;
}

try {
  const args = argumentsFrom(process.argv.slice(2));
  const artifactRoot = args.get("artifact-dir");
  const metadataPath = args.get("artifact-metadata");
  const stateRoot = args.get("state-root") || process.env.RESEARCH_STATE_ROOT;
  if (!artifactRoot || !metadataPath || !stateRoot) {
    throw new Error("Required: --artifact-dir <dir> --artifact-metadata <json> --state-root <absolute-dir>");
  }
  const artifactMetadata = JSON.parse(await readFile(resolve(metadataPath), "utf8"));
  const result = await publishShadowArtifactToStateRootV1({
    artifactRoot: resolve(artifactRoot),
    artifactMetadata,
    stateRoot,
    asOf: args.get("as-of") || new Date().toISOString(),
  });
  process.stdout.write(`${JSON.stringify({
    schemaVersion: "prediction-lab-shadow-state-publication-result-v1",
    status: result.status,
    wrote: result.wrote,
    statePath: result.statePath,
    sourceRunId: result.publication.sourceRunId,
    artifactId: result.publication.artifactId,
    evidenceDigest: result.publication.evidenceDigest,
    PROFITABILITY_PROVEN: false,
    FORWARD_EVIDENCE_SUFFICIENT: result.publication.FORWARD_EVIDENCE_SUFFICIENT,
    executionAuthority: "NONE",
  }, null, 2)}\n`);
} catch (error) {
  const classification = error instanceof ShadowStateRootTransportError ? error.classification : "TRANSPORT_ARGUMENT_INVALID";
  const reason = error instanceof ShadowStateRootTransportError ? error.reason : String(error?.message ?? error).slice(0, 240);
  process.stderr.write(`${JSON.stringify({
    schemaVersion: "prediction-lab-shadow-state-publication-result-v1",
    status: "REJECTED",
    classification,
    reason,
    stateOverwritten: false,
    PROFITABILITY_PROVEN: false,
    FORWARD_EVIDENCE_SUFFICIENT: false,
    executionAuthority: "NONE",
  })}\n`);
  process.exitCode = 1;
}
