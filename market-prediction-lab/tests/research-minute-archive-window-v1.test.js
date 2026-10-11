import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { persistResearchMinuteSessionV1 as store } from "../src/research-minute-archive-v1.js";
import { auditResearchMinuteArchiveWindowV1 as audit } from "../src/research-minute-archive-window-v1.js";
import {
  parseResearchMinuteWindowArgsV1 as parse,
  runResearchMinuteWindowCliV1 as run,
} from "../scripts/research-minute-archive-window-v1.mjs";

const DAY = 86_400_000, MIN = 60_000;
const D0 = Date.parse("2026-09-18T00:00:00Z");
const venues = { KR_STOCK: "KRX", US_STOCK: "US_SIP",
  CRYPTO_SPOT: "UPBIT_KRW", CRYPTO_FUTURES: "BITGET_USDT_FUTURES" };
const symbols = { KR_STOCK: "005930", US_STOCK: "AAPL",
  CRYPTO_SPOT: "KRW-BTC", CRYPTO_FUTURES: "BTCUSDT" };
const hash = rows => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const tmp = () => mkdtempSync(join(tmpdir(), "minute-archive-window-"));
function sample(market, start, { count = 10, sessionMinutes = 30 } = {}) {
  const crypto = market.startsWith("CRYPTO_");
  const sourceId = "TEST_ONLY_READ_ONLY_NATIVE_SOURCE";
  const venue = venues[market], symbol = symbols[market];
  const rows = Array.from({ length: count }, (_, i) => ({
    market, venue, symbol, sourceId,
    timestampMs: start + i * MIN,
    availableAtMs: start + (i + 1) * MIN,
    open: 100 + i, high: 102 + i,
    low: 99 + i, close: 101 + i, volume: i + 10,
  }));
  return {
    market, venue, symbol, sourceId,
    session: { startMs: start,
      endMs: start + (crypto ? DAY : sessionMinutes * MIN),
      kind: crypto ? "UTC_24H" : "REGULAR",
      timeZone: market === "KR_STOCK" ? "Asia/Seoul"
        : market === "US_STOCK" ? "America/New_York" : "UTC",
      calendarSourceId: "TEST_ONLY_UNVERIFIED_EXCHANGE_SESSION" },
    minuteBars: rows, sourceMinuteRowsSha256: hash(rows),
    asOfMs: start + count * MIN,
  };
}
function inputs(root, market, date1 = "2026-09-18", date2 = "2026-09-20",
  additional = {}) {
  return {
    root, market, symbol: symbols[market],
    researchWindow: { startDate: date1, endDate: date2 },
    chunkUtcDays: 31, ...additional,
  };
}
function exchangeDay(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function calendar(market, sessions) {
  return { market, sessions: sessions.map(s => ({
    tradingDateLocal: exchangeDay(s.session.startMs, s.session.timeZone),
    startMs: s.session.startMs, endMs: s.session.endMs,
    kind: s.session.kind, timeZone: s.session.timeZone,
  })) };
}

test("spot 3-day source inventory separates present, missing, conflicting revisions", async () => {
  const root = tmp();
  try {
    const first = sample("CRYPTO_SPOT", D0);
    const last = sample("CRYPTO_SPOT", D0 + 2 * DAY);
    const edited = structuredClone(last);
    edited.minuteBars[0].high += 11;
    edited.sourceMinuteRowsSha256 = hash(edited.minuteBars);
    await store({ root, source: first });
    await store({ root, source: last });
    await store({ root, source: edited });
    const r = await audit(inputs(root, "CRYPTO_SPOT"));
    assert.equal(r.status, "SOURCE_WINDOW_INCOMPLETE_OR_CONFLICTED");
    assert.equal(r.requestedSessionCount, 3);
    assert.equal(r.archivedSessionCount, 1);
    assert.equal(r.missingSessionCount, 1);
    assert.equal(r.revisionConflictSessionCount, 1);
    assert.equal(r.sourceLimitedSessionCount, 1);
    assert.equal(r.originalOneMinuteRows, 10);
    assert.equal(r.sourceUnverifiedOneMinuteSlots, 1430);
    assert.deepEqual(r.missingCollectionPlan.map(x => x.dayUtc), ["2026-09-19"]);
    assert.equal(r.missingCollectionPlan[0].sessionKind, "UTC_24H");
    assert.equal(r.monthlyCoverage["2026-09"].requestedSessions, 3);
    assert.equal(r.nextCursorDate, null);
    assert.equal(r.actualMarketWideOpportunityCount, null);
    assert.equal(r.trueMarketWideRecall, null);
    assert.equal(r.profitabilityProven, false);
    assert.equal(r.executionAuthority, "NONE");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("selected ten-year period pages without scanning or claiming full coverage", async () => {
  const root = tmp();
  try {
    const first = await audit(inputs(root, "CRYPTO_FUTURES",
      "2016-01-01", "2025-12-31", { chunkUtcDays: 31 }));
    assert.equal(first.selectedResearchStartUtc, "2016-01-01");
    assert.equal(first.selectedResearchEndInclusiveUtc, "2025-12-31");
    assert.ok(first.selectedResearchUtcDayCount > 3650);
    assert.equal(first.inspectedStartUtc, "2016-01-01");
    assert.equal(first.inspectedEndInclusiveUtc, "2016-01-31");
    assert.equal(first.nextCursorDate, "2016-02-01");
    assert.equal(first.requestedSessionCount, 31);
    assert.equal(first.missingSessionCount, 31);
    assert.equal(first.missingCollectionPlan.length, 31);
    const next = await audit(inputs(root, "CRYPTO_FUTURES",
      "2016-01-01", "2025-12-31", {
        chunkUtcDays: 31, cursorDate: first.nextCursorDate,
      }));
    assert.equal(next.inspectedStartUtc, "2016-02-01");
    assert.equal(next.inspectedEndInclusiveUtc, "2016-03-02");
    assert.equal(next.nextCursorDate, "2016-03-03");
    assert.equal(next.actualFillCount, null);
    await assert.rejects(() => audit(inputs(root, "CRYPTO_FUTURES",
      "2016-01-01", "2025-12-31", { cursorDate: "2026-01-01" })),
    /MINUTE_WINDOW_CURSOR_OUTSIDE_SELECTION/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("KR and US do not invent weekday sessions without a dated stock calendar", async () => {
  const root = tmp();
  try {
    for (const market of ["KR_STOCK", "US_STOCK"]) {
      const report = await audit(inputs(root, market));
      assert.equal(report.status, "BLOCKED_STOCK_SESSION_CALENDAR_MISSING");
      assert.equal(report.requestedSessionCount, null);
      assert.equal(report.missingSessionCount, null);
      assert.equal(report.stockCalendarIndependentlyVerified, false);
      const empty = await audit(inputs(root, market, "2026-09-18", "2026-09-18", {
        stockCalendar: { market, sessions: [] },
      }));
      assert.equal(empty.status, "BLOCKED_STOCK_SESSION_CALENDAR_EMPTY");
      assert.equal(empty.requestedSessionCount, null);
      assert.equal(empty.trueMarketWideRecall, null);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stock calendar and archived end-time must match; DST is caller dated", async () => {
  const root = tmp();
  try {
    for (const market of ["KR_STOCK", "US_STOCK"]) {
      const start = market === "US_STOCK"
        ? Date.parse("2026-09-18T13:30:00Z") : D0;
      const src = sample(market, start);
      await store({ root, source: src });
      const cal = calendar(market, [src]);
      const r = await audit(inputs(root, market, "2026-09-18", "2026-09-18", {
        stockCalendar: cal,
      }));
      assert.equal(r.status, "SOURCE_WINDOW_INCOMPLETE_OR_CONFLICTED");
      assert.equal(r.archivedSessionCount, 1);
      assert.equal(r.sourceLimitedSessionCount, 1);
      assert.equal(r.sourceUnverifiedOneMinuteSlots, 20);
      assert.equal(r.stockCalendarStatus, "CALLER_PROVIDED_STOCK_SESSIONS_UNAUTHENTICATED");
      assert.equal(r.researchDateBasis, "EXCHANGE_LOCAL_TRADING_DATE");
      assert.equal(r.inspectedStartDate, "2026-09-18");
      assert.equal(r.inspectedStartUtc, null);
      assert.equal(r.stockCalendarIndependentlyVerified, false);
      const wrong = structuredClone(cal);
      wrong.sessions[0].endMs += 60 * MIN;
      const mismatch = await audit(inputs(root, market,
        "2026-09-18", "2026-09-18", { stockCalendar: wrong }));
      assert.equal(mismatch.unreadableSessionCount, 1);
      assert.equal(mismatch.archivedSessionCount, 0);
      assert.equal(mismatch.warningsPreview[0].reason, "ARCHIVE_SESSION_PROVENANCE_MISMATCH");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("KR premarket 08:30 KST belongs to next UTC day's local trading date", async () => {
  const root = tmp();
  try {
    const preStart = Date.parse("2026-09-17T23:30:00Z"); // Sep 18 08:30 KST
    const regularStart = D0; // Sep 18 09:00 KST
    const pre = sample("KR_STOCK", preStart);
    pre.session.kind = "PREMARKET";
    const regular = sample("KR_STOCK", regularStart);
    await store({ root, source: pre });
    await store({ root, source: regular });
    const r = await audit(inputs(root, "KR_STOCK", "2026-09-18", "2026-09-18", {
      stockCalendar: calendar("KR_STOCK", [pre, regular]),
    }));
    assert.equal(r.inspectedStartDate, "2026-09-18");
    assert.equal(r.researchDateBasis, "EXCHANGE_LOCAL_TRADING_DATE");
    assert.equal(r.requestedSessionCount, 2);
    assert.equal(r.archivedSessionCount, 2);
    assert.equal(r.missingSessionCount, 0);
    assert.equal(r.monthlyCoverage["2026-09"].requestedSessions, 2);
    assert.equal(r.stockCalendarIndependentlyVerified, false);
    const missingRoot = tmp();
    try {
      const notSaved = await audit(inputs(missingRoot, "KR_STOCK",
        "2026-09-18", "2026-09-18", {
          stockCalendar: calendar("KR_STOCK", [pre, regular]),
        }));
      assert.equal(notSaved.missingSessionCount, 2);
      assert.deepEqual(notSaved.missingCollectionPlan.map(x => x.tradingDateLocal),
        ["2026-09-18", "2026-09-18"]);
      assert.equal(notSaved.missingCollectionPlan[0].sessionStartMs, preStart);
      assert.equal(notSaved.missingCollectionPlan[1].sessionStartMs, regularStart);
    } finally { rmSync(missingRoot, { recursive: true, force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("US winter EST and summer EDT are different UTC starts for same local open", async () => {
  const root = tmp();
  try {
    const dates = [
      ["2026-01-12", Date.parse("2026-01-12T14:30:00Z")],
      ["2026-09-18", Date.parse("2026-09-18T13:30:00Z")],
    ];
    for (const [localDate, startMs] of dates) {
      const original = sample("US_STOCK", startMs);
      await store({ root, source: original });
      const report = await audit(inputs(root, "US_STOCK", localDate, localDate, {
        stockCalendar: calendar("US_STOCK", [original]),
      }));
      assert.equal(report.archivedSessionCount, 1);
      assert.equal(report.missingSessionCount, 0);
      assert.equal(report.researchDateBasis, "EXCHANGE_LOCAL_TRADING_DATE");
      assert.equal(report.selectedResearchStartDate, localDate);
      assert.equal(report.trueMarketWideRecall, null);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a full 1440-minute archive is still not full PIT or actual market recall", async () => {
  const root = tmp();
  try {
    const src = sample("CRYPTO_FUTURES", D0, { count: 1440 });
    await store({ root, source: src });
    const r = await audit(inputs(root, "CRYPTO_FUTURES", "2026-09-18", "2026-09-18"));
    assert.equal(r.status, "SOURCE_PRESENT_BUT_NOT_INDEPENDENTLY_AUTHENTICATED");
    assert.equal(r.sourceLimitedSessionCount, 0);
    assert.equal(r.archivedSessionCount, 1);
    assert.equal(r.originalOneMinuteRows, 1440);
    assert.equal(r.venuePITUniverseIndependentlyVerified, false);
    assert.equal(r.wholeHistoricMarketPopulationVerified, false);
    assert.equal(r.noTradeMinuteEvidenceVerified, false);
    assert.equal(r.actualMarketWideOpportunityCount, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("corrupt original is blocked without hiding other missing sessions", async () => {
  const root = tmp();
  try {
    const src = sample("CRYPTO_SPOT", D0);
    const inserted = await store({ root, source: src });
    writeFileSync(inserted.path, "corrupt compressed data 123456789012345");
    const report = await audit(inputs(root, "CRYPTO_SPOT", "2026-09-18", "2026-09-19"));
    assert.equal(report.unreadableSessionCount, 1);
    assert.equal(report.archivedSessionCount, 0);
    assert.equal(report.missingSessionCount, 1);
    assert.equal(report.missingCollectionPlan[0].dayUtc, "2026-09-19");
    assert.equal(report.warningsPreview[0].reason, "ARCHIVED_ORIGINAL_UNREADABLE_OR_INVALID");
    assert.equal(report.actualFillCount, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("invalid provider calendar, dates and oversized chunks fail before lookup", async () => {
  const root = tmp();
  try {
    const invalids = [
      { cursorDate: "2026-09-21" }, { cursorDate: "2026-09-18bad" },
      { chunkUtcDays: 32 }, { chunkUtcDays: 0 },
    ];
    for (const opts of invalids) {
      await assert.rejects(() => audit(inputs(root, "CRYPTO_SPOT",
        "2026-09-18", "2026-09-20", opts)), /MINUTE_WINDOW_/);
    }
    await assert.rejects(() => audit(inputs(root, "KR_STOCK",
      "2026-09-18", "2026-09-19", {
        stockCalendar: { market: "KR_STOCK", sessions: [{
          tradingDateLocal: "2026-09-17", startMs: D0,
          endMs: D0 + 30 * MIN,
          kind: "REGULAR", timeZone: "Asia/Seoul",
        }] },
      })), /MINUTE_WINDOW_STOCK_CALENDAR_INVALID/);
    await assert.rejects(() => audit(inputs(root, "CRYPTO_SPOT",
      "2026-09-18", "2026-09-20", {
        stockCalendar: { market: "CRYPTO_SPOT", sessions: [] },
      })), /MINUTE_WINDOW_CRYPTO_CALENDAR_UNEXPECTED/);
    await assert.rejects(() => audit(inputs(root, "CRYPTO_SPOT",
      "2026-02-30", "2026-03-01")), /RESEARCH_WINDOW_DATES_INVALID/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("private CLI emits bounded summary, supports cursor, never overwrites", async () => {
  const root = tmp();
  try {
    const source = sample("CRYPTO_SPOT", D0);
    await store({ root, source });
    const output = join(root, "first-chunk.json");
    const args = ["--root", root, "--market", "CRYPTO_SPOT", "--symbol", "KRW-BTC",
      "--start-date", "2026-09-18", "--end-date", "2026-09-20",
      "--chunk-days", "2", "--output", output];
    const first = await run(parse(args));
    assert.equal(first.inspectedEndInclusiveUtc, "2026-09-19");
    assert.equal(first.nextCursorDate, "2026-09-20");
    assert.equal(first.archivedSessionCount, 1);
    assert.equal(first.missingSessionCount, 1);
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(saved.missingCollectionPlan[0].dayUtc, "2026-09-19");
    assert.equal(saved.executionAuthority, "NONE");
    assert.equal(statSync(output).mode & 0o077, 0);
    await assert.rejects(() => run(parse(args)), /MINUTE_WINDOW_OUTPUT_ALREADY_EXISTS/);
    const second = await run(parse([
      ...args.slice(0, -2), "--cursor-date", first.nextCursorDate,
      "--output", join(root, "last-chunk.json"),
    ]));
    assert.equal(second.requestedSessionCount, 1);
    assert.equal(second.nextCursorDate, null);
    assert.equal(second.inspectedStartUtc, "2026-09-20");
    const alias = join(tmpdir(), "minute-window-output-alias-" + process.pid);
    symlinkSync(root, alias, "dir");
    try {
      await assert.rejects(() => run(parse([
        ...args.slice(0, -2), "--output", join(alias, "leak.json"),
      ])), /MINUTE_WINDOW_OUTPUT_PARENT_SYMLINK_FORBIDDEN/);
    } finally { rmSync(alias, { force: true }); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("stock CLI private calendar scope is checked and sources never public", async () => {
  const root = tmp();
  try {
    const source = sample("KR_STOCK", D0);
    await store({ root, source });
    const file = join(root, "private-stock-calendar.json");
    const output = join(root, "stock-summary.json");
    writeFileSync(file, JSON.stringify(calendar("KR_STOCK", [source])),
      { mode: 0o600 });
    const args = ["--root", root, "--market", "KR_STOCK", "--symbol", "005930",
      "--start-date", "2026-09-18", "--end-date", "2026-09-18",
      "--stock-calendar", file, "--output", output];
    const r = await run(parse(args));
    assert.equal(r.archivedSessionCount, 1);
    assert.equal(r.requestedSessionCount, 1);
    assert.equal(r.executionAuthority, "NONE");
    const saved = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(saved.stockCalendarIndependentlyVerified, false);
    assert.equal(saved.trueMarketWideRecall, null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
