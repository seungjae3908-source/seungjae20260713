#!/usr/bin/env node
/**
 * OFFLINE, read-only, 31-day-or-shorter inventory and missing-source plan.
 *
 * node scripts/research-minute-archive-window-v1.mjs
 *   --root /private/research-minutes --market CRYPTO_SPOT --symbol KRW-BTC
 *   --start-date 2020-01-01 --end-date 2026-09-30 --chunk-days 31
 *   --output /private/reports/2020-01-01.json
 *
 * Resume at nextCursorDate from previous result with --cursor-date.
 * For stock markets, explicitly supply --stock-calendar /private/sessions.json
 * with {"market":"KR_STOCK","sessions":[{"tradingDateLocal":"2026-09-18",
 * "startMs":...,"endMs":...,"kind":"PREMARKET","timeZone":"Asia/Seoul"}]}.
 * Stock selected start/end/cursor are exchange-LOCAL trading dates; crypto UTC.
 * No HTTP/provider download, DB/secret write, order, CI artifact or deployment.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditResearchMinuteArchiveWindowV1 } from "../src/research-minute-archive-window-v1.js";

const FLAGS = new Set([
  "--root", "--market", "--symbol", "--start-date", "--end-date",
  "--cursor-date", "--chunk-days", "--stock-calendar", "--output",
]);
const REQUIRED = ["--root", "--market", "--symbol", "--start-date", "--end-date", "--output"];
export function parseResearchMinuteWindowArgsV1(args = []) {
  if (!Array.isArray(args) || args.length < 12 || args.length > 18
    || args.length % 2 !== 0)
    throw new TypeError("MINUTE_WINDOW_CLI_ARGS_INVALID");
  const fields = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!FLAGS.has(args[i]) || Object.hasOwn(fields, args[i])
      || typeof args[i + 1] !== "string"
      || !args[i + 1].trim() || args[i + 1].startsWith("--"))
      throw new TypeError("MINUTE_WINDOW_CLI_OPTION_INVALID");
    fields[args[i]] = args[i + 1];
  }
  const root = fields["--root"], output = fields["--output"];
  const calendar = fields["--stock-calendar"] ?? null;
  if (!REQUIRED.every(x => Object.hasOwn(fields, x))
    || !isAbsolute(root ?? "") || resolve(root) !== root
    || !isAbsolute(output ?? "") || resolve(output) === resolve(root)
    || (calendar !== null && (!isAbsolute(calendar)
      || resolve(calendar) === resolve(output))))
    throw new TypeError("MINUTE_WINDOW_CLI_SCOPE_INVALID");
  if (fields["--chunk-days"] != null &&
    !/^(?:[1-9]|[12][0-9]|3[01])$/u.test(fields["--chunk-days"]))
    throw new TypeError("MINUTE_WINDOW_CLI_CHUNK_INVALID");
  return Object.freeze({
    root, market: fields["--market"], symbol: fields["--symbol"],
    researchWindow: {
      startDate: fields["--start-date"], endDate: fields["--end-date"],
    },
    cursorDate: fields["--cursor-date"] ?? null,
    chunkUtcDays: Number(fields["--chunk-days"] ?? "7"),
    stockCalendarPath: calendar, outputPath: resolve(output),
  });
}
function readPrivateCalendar(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
    || (st.mode & 0o077) !== 0 || st.size < 2 || st.size > 8 * 1024 * 1024)
    throw new TypeError("MINUTE_WINDOW_PRIVATE_CALENDAR_FILE_REQUIRED");
  return JSON.parse(readFileSync(path, "utf8"));
}
function rejectOutputSymlinkAncestors(path) {
  let current = dirname(path);
  while (true) {
    try {
      const st = lstatSync(current);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw new TypeError("MINUTE_WINDOW_OUTPUT_PARENT_SYMLINK_FORBIDDEN");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export async function runResearchMinuteWindowCliV1(config) {
  if (!config || typeof config.outputPath !== "string"
    || !isAbsolute(config.outputPath))
    throw new TypeError("MINUTE_WINDOW_CLI_CONFIG_INVALID");
  // Reject occupied output before any potentially licensed private source read.
  try {
    lstatSync(config.outputPath);
    throw new TypeError("MINUTE_WINDOW_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  rejectOutputSymlinkAncestors(config.outputPath);
  const stockCalendar = config.stockCalendarPath == null
    ? null : readPrivateCalendar(config.stockCalendarPath);
  const result = await auditResearchMinuteArchiveWindowV1({
    root: config.root, market: config.market, symbol: config.symbol,
    researchWindow: config.researchWindow, cursorDate: config.cursorDate,
    chunkUtcDays: config.chunkUtcDays, stockCalendar,
  });
  mkdirSync(dirname(config.outputPath), { recursive: true, mode: 0o700 });
  rejectOutputSymlinkAncestors(config.outputPath);
  writeFileSync(config.outputPath, JSON.stringify(result, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  return Object.freeze({
    status: result.status, market: result.market, symbol: result.symbol,
    researchDateBasis: result.researchDateBasis,
    inspectedStartDate: result.inspectedStartDate,
    inspectedEndInclusiveDate: result.inspectedEndInclusiveDate,
    inspectedStartUtc: result.inspectedStartUtc,
    inspectedEndInclusiveUtc: result.inspectedEndInclusiveUtc,
    nextCursorDate: result.nextCursorDate,
    requestedSessionCount: result.requestedSessionCount,
    archivedSessionCount: result.archivedSessionCount,
    missingSessionCount: result.missingSessionCount,
    sourceLimitedSessionCount: result.sourceLimitedSessionCount,
    trueMarketWideRecall: null, profitabilityProven: false,
    executionAuthority: "NONE",
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = parseResearchMinuteWindowArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(await runResearchMinuteWindowCliV1(config)) + "\n");
}
