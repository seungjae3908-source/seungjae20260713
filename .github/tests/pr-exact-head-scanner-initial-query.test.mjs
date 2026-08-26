import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const scannerSource = readFileSync(
  new URL("../../stock-analyzer/src/pages/scanner.tsx", import.meta.url),
  "utf8",
);

test("Scanner restores persisted thresholds before its first query", () => {
  const lazyInitializers =
    scannerSource.match(/useState<ThresholdOption>\(loadThreshold\)/g) ?? [];

  assert.equal(
    lazyInitializers.length,
    2,
    "volume and trading-value thresholds must both lazy-load persisted state before the first scan query",
  );

  assert.doesNotMatch(
    scannerSource,
    /const savedThreshold = loadThreshold\(\);[\s\S]*setVolumeThreshold\(savedThreshold\);[\s\S]*setTradingValueThreshold\(savedThreshold\);/,
    "Scanner must not launch the default-threshold query and replace thresholds after mount",
  );

  assert.match(
    scannerSource,
    /if \(typeof window === "undefined"\) return DEFAULT_THRESHOLD;/,
    "SSR-safe threshold fallback must remain intact",
  );

  assert.match(
    scannerSource,
    /window\.localStorage\.getItem\(THRESHOLD_STORAGE_KEY\)/,
    "persisted threshold source must remain localStorage",
  );
});
