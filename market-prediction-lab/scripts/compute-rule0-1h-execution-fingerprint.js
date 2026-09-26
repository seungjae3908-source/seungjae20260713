#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RULE0_1H_EXECUTION_FINGERPRINT_SCHEMA = 1;

export const RULE0_1H_EXECUTION_ROOTS = Object.freeze([
  ".github/workflows/prediction-lab-rule0-1h-shadow-sidecar.yml",
  "market-prediction-lab/package.json",
  "market-prediction-lab/scripts/compute-rule0-1h-execution-fingerprint.js",
  "market-prediction-lab/scripts/run-rule-model-1h-shadow-sidecar.js",
  "market-prediction-lab/docs/rule-model-1h-shadow-model.json",
  "market-prediction-lab/docs/rule-model-1h-shadow-contract.json",
]);

function digestBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function normalizeRepoPath(value) {
  return value.split(path.sep).join("/");
}

function assertInsideRepo(repoRoot, absolutePath) {
  const relative = path.relative(repoRoot, absolutePath);
  if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return relative;
  throw new Error(`execution dependency escapes repository root: ${absolutePath}`);
}

function extractRelativeSpecifiers(source) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]?.startsWith("./") || match[1]?.startsWith("../")) specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

function resolveRelativeImport(repoRoot, importerAbsolutePath, specifier) {
  const raw = path.resolve(path.dirname(importerAbsolutePath), specifier);
  const candidates = path.extname(raw)
    ? [raw]
    : [raw, `${raw}.js`, `${raw}.mjs`, `${raw}.json`, path.join(raw, "index.js"), path.join(raw, "index.mjs")];
  for (const candidate of candidates) {
    assertInsideRepo(repoRoot, candidate);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  throw new Error(`unable to resolve relative import ${specifier} from ${normalizeRepoPath(path.relative(repoRoot, importerAbsolutePath))}`);
}

export function collectRule0ExecutionDependencies(repoRoot, roots = RULE0_1H_EXECUTION_ROOTS) {
  const absoluteRepoRoot = path.resolve(repoRoot);
  const queue = roots.map((entry) => path.resolve(absoluteRepoRoot, entry));
  const visited = new Set();

  while (queue.length > 0) {
    const absolutePath = queue.shift();
    const relative = assertInsideRepo(absoluteRepoRoot, absolutePath);
    const repoPath = normalizeRepoPath(relative);
    if (visited.has(repoPath)) continue;
    if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
      throw new Error(`missing execution dependency: ${repoPath}`);
    }
    visited.add(repoPath);

    if (absolutePath.endsWith(".js") || absolutePath.endsWith(".mjs")) {
      const source = fs.readFileSync(absolutePath, "utf8");
      for (const specifier of extractRelativeSpecifiers(source)) {
        queue.push(resolveRelativeImport(absoluteRepoRoot, absolutePath, specifier));
      }
    }
  }

  const files = [...visited].sort().map((repoPath) => {
    const bytes = fs.readFileSync(path.resolve(absoluteRepoRoot, repoPath));
    return Object.freeze({ path: repoPath, sha256: digestBuffer(bytes), size: bytes.length });
  });
  const fingerprintPayload = files.map((file) => `${file.path}\0${file.sha256}\n`).join("");
  return Object.freeze({
    schemaVersion: RULE0_1H_EXECUTION_FINGERPRINT_SCHEMA,
    roots: Object.freeze([...roots]),
    files: Object.freeze(files),
    fingerprint: digestBuffer(Buffer.from(fingerprintPayload, "utf8")),
  });
}

function parseArgs(argv) {
  const args = { repoRoot: process.cwd(), output: null, format: "json" };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--repo-root") args.repoRoot = argv[++index];
    else if (value === "--output") args.output = argv[++index];
    else if (value === "--format") args.format = argv[++index];
    else throw new Error(`unknown argument: ${value}`);
  }
  if (!args.repoRoot) throw new Error("--repo-root requires a value");
  if (args.format !== "json" && args.format !== "fingerprint") throw new Error("--format must be json or fingerprint");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = collectRule0ExecutionDependencies(args.repoRoot);
  const output = args.format === "fingerprint" ? `${result.fingerprint}\n` : `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) fs.writeFileSync(args.output, output);
  else process.stdout.write(output);
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) main();
