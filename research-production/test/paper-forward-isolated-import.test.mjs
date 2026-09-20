import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LAB_ROOT = join(REPO_ROOT, "market-prediction-lab");

test("Paper Forward entrypoint imports from an isolated market-prediction-lab workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "paper-forward-isolated-import-"));
  const workspace = join(root, "market-prediction-lab");
  try {
    await cp(LAB_ROOT, workspace, {
      recursive: true,
      force: false,
      errorOnExist: true,
      dereference: false,
      filter: (source) => !source.includes("/node_modules/"),
    });

    const entrypoint = join(workspace, "scripts", "run-paper-forward-schedule.js");
    const imported = await import(`${pathToFileURL(entrypoint).href}?isolated=${Date.now()}`);

    assert.equal(typeof imported.runPaperForwardScheduleCli, "function");
    assert.equal(typeof imported.buildAutonomousAlphaNaturalPaperObserverReceiptV1, "function");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lightweight Alpha readiness has no relative imports outside market-prediction-lab", async () => {
  const path = join(
    LAB_ROOT,
    "src",
    "autonomous-alpha-architecture-readiness-v1.js",
  );
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(path, "utf8"));
  const imports = [...source.matchAll(/from\s+["']([^"']+)["']/gu)].map((match) => match[1]);

  assert.deepEqual(imports, ["node:crypto"]);
  assert.equal(source.includes("../../packages/"), false);
});
