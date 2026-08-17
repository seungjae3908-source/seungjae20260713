import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { collectRule0ExecutionDependencies } from "../scripts/compute-rule0-1h-execution-fingerprint.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function withFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rule0-fingerprint-"));
  try {
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "entry.js"), 'import { value } from "./src/a.js";\nconsole.log(value);\n');
    fs.writeFileSync(path.join(root, "src/a.js"), 'export { value } from "./b.js";\n');
    fs.writeFileSync(path.join(root, "src/b.js"), 'export const value = 1;\n');
    fs.writeFileSync(path.join(root, "unrelated.txt"), "outside closure\n");
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Rule0 execution fingerprint follows transitive relative imports deterministically", () => {
  withFixture((root) => {
    const first = collectRule0ExecutionDependencies(root, ["entry.js"]);
    const second = collectRule0ExecutionDependencies(root, ["entry.js"]);
    assert.equal(first.fingerprint, second.fingerprint);
    assert.deepEqual(first.files.map((file) => file.path), ["entry.js", "src/a.js", "src/b.js"]);

    fs.writeFileSync(path.join(root, "unrelated.txt"), "changed but still outside closure\n");
    const unrelatedChanged = collectRule0ExecutionDependencies(root, ["entry.js"]);
    assert.equal(unrelatedChanged.fingerprint, first.fingerprint);

    fs.writeFileSync(path.join(root, "src/b.js"), 'export const value = 2;\n');
    const dependencyChanged = collectRule0ExecutionDependencies(root, ["entry.js"]);
    assert.notEqual(dependencyChanged.fingerprint, first.fingerprint);
  });
});

test("canonical Rule0 1h fingerprint includes prediction, collection and settlement dependencies", () => {
  const result = collectRule0ExecutionDependencies(repoRoot);
  const paths = new Set(result.files.map((file) => file.path));
  const required = [
    ".github/workflows/prediction-lab-rule0-1h-shadow-sidecar.yml",
    "market-prediction-lab/package.json",
    "market-prediction-lab/scripts/run-rule-model-1h-shadow-sidecar.js",
    "market-prediction-lab/src/engine.js",
    "market-prediction-lab/src/contracts.js",
    "market-prediction-lab/src/indicators.js",
    "market-prediction-lab/src/rules.js",
    "market-prediction-lab/src/tiny-model.js",
    "market-prediction-lab/src/bitget-public-client.js",
    "market-prediction-lab/src/bitget-candle-collector.js",
    "market-prediction-lab/src/derivatives-history.js",
    "market-prediction-lab/src/shadow-ledger.js",
    "market-prediction-lab/src/rule-model-shadow-challenger.js",
    "market-prediction-lab/src/rule-model-blend-challenger.js",
  ];
  for (const requiredPath of required) assert.equal(paths.has(requiredPath), true, `missing ${requiredPath}`);
  assert.match(result.fingerprint, /^[0-9a-f]{64}$/);
});
