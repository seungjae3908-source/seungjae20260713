#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import {
  buildAuthenticatedShadowBlendCollapseDiagnostic,
  buildShadowBlendCollapseDiagnostic,
} from "../src/shadow-blend-collapse-diagnostics-v1.js";
import { buildShadowDirectionalRescueCandidateV1 } from "../src/shadow-directional-rescue-v1.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requireArg(name) {
  const value = argValue(name);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function writeResult(result, outputPath) {
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), serialized, "utf8");
  else process.stdout.write(serialized);
}

const inputPath = argValue("--input");
const artifactDir = argValue("--artifact-dir");
const outputPath = argValue("--output");

try {
  if (artifactDir) {
    const root = path.resolve(artifactDir);
    const modelPath = path.resolve(requireArg("--model-artifact"));
    const authenticated = buildAuthenticatedShadowBlendCollapseDiagnostic({
      manifestBytes: fs.readFileSync(path.join(root, "manifest.json")),
      stateBytes: fs.readFileSync(path.join(root, "shadow-state.json")),
      summaryBytes: fs.readFileSync(path.join(root, "shadow-summary.json")),
      modelArtifactBytes: fs.readFileSync(modelPath),
      artifactIdentity: {
        workflowRunId: Number(requireArg("--workflow-run-id")),
        artifactId: Number(requireArg("--artifact-id")),
        artifactDigest: requireArg("--artifact-digest"),
      },
      modelBlobSha: requireArg("--model-blob-sha"),
      minSettledN: Number(argValue("--min-settled-n") ?? 12),
      generatedAt: Date.now(),
    });
    const result = Object.freeze({
      ...authenticated,
      directionalRescueCandidate: buildShadowDirectionalRescueCandidateV1(authenticated, {
        workflowRunHead: requireArg("--workflow-run-head"),
        createdAt: requireArg("--artifact-created-at"),
        expiresAt: requireArg("--artifact-expires-at"),
        checkedAt: argValue("--checked-at") ?? new Date().toISOString(),
      }),
    });
    writeResult(result, outputPath);
  } else if (inputPath) {
    const payload = JSON.parse(fs.readFileSync(path.resolve(inputPath), "utf8"));
    const result = buildShadowBlendCollapseDiagnostic({
      observations: payload.observations,
      timeframe: payload.timeframe ?? "15m",
      minSettledN: payload.minSettledN ?? 12,
      declaredBlendWeights: payload.declaredBlendWeights,
      researchCodeSha: payload.researchCodeSha ?? null,
      generatedAt: payload.generatedAt ?? Date.now(),
    });
    writeResult(result, outputPath);
  } else {
    throw new Error("usage: --artifact-dir <dir> --model-artifact <json> --workflow-run-id <id> --artifact-id <id> --artifact-digest <sha256:...> --model-blob-sha <sha> --workflow-run-head <sha> --artifact-created-at <iso> --artifact-expires-at <iso> [--checked-at <iso>] [--output <json>] OR --input <json>");
  }
} catch (error) {
  console.error(error?.stack ?? error?.message ?? String(error));
  process.exitCode = 1;
}
