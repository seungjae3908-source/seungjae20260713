import assert from "node:assert/strict";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  SPOT_SPREAD_ARCHIVE_FIRST_ZERO,
  SPOT_SPREAD_OWNER_RESOLVES,
  buildScannerSpotSpreadObservationV1,
  persistScannerSpotSpreadObservationV1,
  summarizeScannerSpotSpreadArchiveV1,
} from "../src/scanner-spot-spread-archive-v1.js";

const SHA = "a".repeat(40);
const NOW = Date.parse("2026-09-27T10:00:00.000Z");

function orderbook(timestamp = NOW - 1000, overrides = {}) {
  return [{
    market: "KRW-BTC",
    timestamp,
    orderbook_units: [
      { bid_price: 100, bid_size: 2, ask_price: 100.5, ask_size: 1.5 },
      { bid_price: 99.5, bid_size: 3, ask_price: 101, ask_size: 3 },
      { bid_price: 99, bid_size: 5, ask_price: 101.5, ask_size: 5 },
    ],
    ...overrides,
  }];
}

test("builds public-only immutable spread observation from exact Upbit orderbook", () => {
  const built = buildScannerSpotSpreadObservationV1({
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(),
  });
  assert.equal(built.status, "READY");
  assert.equal(built.observation.status, "SPOT_SPREAD_OBSERVATION_READY");
  assert.equal(built.observation.market, "CRYPTO_SPOT");
  assert.equal(built.observation.exchange, "UPBIT");
  assert.equal(built.observation.symbol, "BTC");
  assert.equal(built.observation.bestBid, 100);
  assert.equal(built.observation.bestAsk, 100.5);
  assert.ok(built.observation.spreadBps > 0);
  assert.match(built.observation.sourceDigest, /^[0-9a-f]{64}$/u);
  assert.match(built.observation.observationDigest, /^[0-9a-f]{64}$/u);
  assert.equal(built.observation.economicSampleCredit, 0);
  assert.equal(built.observation.safety.executionAuthority, "NONE");
  assert.equal(built.observation.safety.historicalBackfillAllowed, false);
  assert.equal(built.observation.safety.syntheticSpreadAllowed, false);
});

test("crossed/locked or stale/future provider books fail closed", () => {
  let built = buildScannerSpotSpreadObservationV1({
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(NOW - 1000, {
      orderbook_units: [{ bid_price: 101, bid_size: 1, ask_price: 100.5, ask_size: 1 }],
    }),
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.ok(built.blockers.includes("SPOT_SPREAD_MICROSTRUCTURE_SNAPSHOT_BLOCKED"));

  built = buildScannerSpotSpreadObservationV1({
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(NOW - 10 * 60 * 1000),
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.ok(built.blockers.includes("SPOT_SPREAD_PROVIDER_TIMESTAMP_STALE"));

  built = buildScannerSpotSpreadObservationV1({
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(NOW + 60_000),
  });
  assert.equal(built.status, "BLOCKED_DATA");
  assert.ok(built.blockers.includes("SPOT_SPREAD_PROVIDER_TIMESTAMP_FROM_FUTURE"));
});

test("append-only persistence is idempotent and rejects symlink roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "spot-spread-"));
  const first = await persistScannerSpotSpreadObservationV1({
    stateRoot: root,
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(),
  });
  assert.equal(first.status, "READY");
  assert.equal(first.persistence.status, "created");

  const second = await persistScannerSpotSpreadObservationV1({
    stateRoot: root,
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(),
  });
  assert.equal(second.persistence.status, "already_present");
  const stored = JSON.parse(await readFile(first.persistence.path, "utf8"));
  assert.equal(stored.observationDigest, first.observation.observationDigest);

  const outside = await mkdtemp(path.join(os.tmpdir(), "spot-spread-outside-"));
  const holder = await mkdtemp(path.join(os.tmpdir(), "spot-spread-holder-"));
  const link = path.join(holder, "state-link");
  await symlink(outside, link, "dir");
  await assert.rejects(
    persistScannerSpotSpreadObservationV1({
      stateRoot: link,
      researchCodeSha: SHA,
      symbol: "BTC",
      capturedAtMs: NOW,
      orderbook: orderbook(),
    }),
    /SYMLINK_FORBIDDEN/u,
  );
});

test("one genuine observation resolves owner-missing FIRST_ZERO but not historical coverage", () => {
  const built = buildScannerSpotSpreadObservationV1({
    researchCodeSha: SHA,
    symbol: "BTC",
    capturedAtMs: NOW,
    orderbook: orderbook(),
  });
  assert.equal(built.status, "READY");

  const summary = summarizeScannerSpotSpreadArchiveV1({
    observations: [built.observation],
    researchCodeSha: SHA,
    symbol: "BTC",
    requiredStartTime: NOW - 10 * 4 * 60 * 60 * 1000,
    requiredEndTime: NOW,
  });
  assert.equal(summary.status, "FORWARD_ACCUMULATING");
  assert.equal(summary.ownerReady, true);
  assert.equal(summary.historicalReplayReady, false);
  assert.equal(summary.resolvesFirstZero, SPOT_SPREAD_OWNER_RESOLVES);
  assert.equal(summary.nextFirstZero, SPOT_SPREAD_ARCHIVE_FIRST_ZERO);
  assert.equal(summary.expected4hBucketCount, 10);
  assert.equal(summary.covered4hBucketCount, 1);
  assert.equal(summary.missing4hBucketCount, 9);
  assert.equal(summary.economicSampleCredit, 0);
  assert.equal(summary.safety.scheduleActivated, false);
});

test("archive becomes replay-ready only when every required 4H bucket has observed evidence", () => {
  const start = NOW - 3 * 4 * 60 * 60 * 1000;
  const observations = [];
  for (let index = 0; index < 3; index += 1) {
    const captured = start + index * 4 * 60 * 60 * 1000 + 60_000;
    const built = buildScannerSpotSpreadObservationV1({
      researchCodeSha: SHA,
      symbol: "BTC",
      capturedAtMs: captured,
      orderbook: orderbook(captured - 1000),
    });
    observations.push(built.observation);
  }
  const summary = summarizeScannerSpotSpreadArchiveV1({
    observations,
    researchCodeSha: SHA,
    symbol: "BTC",
    requiredStartTime: start,
    requiredEndTime: NOW,
  });
  assert.equal(summary.status, "READY");
  assert.equal(summary.historicalReplayReady, true);
  assert.equal(summary.missing4hBucketCount, 0);
  assert.equal(summary.nextFirstZero, "SPOT_SCANNER_EXACT_OOS_WF_PACKET_NOT_MATERIALIZED");
  assert.equal(summary.economicSampleCredit, 0);
});
