#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { buildShadowBlendCollapseDiagnostic } from "../src/shadow-blend-collapse-diagnostics-v1.js";

function argValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

const inputPath = argValue("--input");
const outputPath = argValue("--output");
if (!inputPath) {
  console.error("usage: node scripts/run-shadow-blend-collapse-diagnostics-v1.js --input <json> [--output <json>]");
  process.exitCode = 2;
} else {
  const absoluteInput = path.resolve(inputPath);
  const payload = JSON.parse(fs.readFileSync(absoluteInput, "utf8"));
  const result = buildShadowBlendCollapseDiagnostic({
    observations: payload.observations,
    timeframe: payload.timeframe ?? "15m",
    minSettledN: payload.minSettledN ?? 12,
    declaredBlendWeights: payload.declaredBlendWeights ?? { rule: 0.65, model: 0.35 },
    researchCodeSha: payload.researchCodeSha ?? null,
    generatedAt: payload.generatedAt ?? Date.now(),
  });
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), serialized, "utf8");
  else process.stdout.write(serialized);
}
