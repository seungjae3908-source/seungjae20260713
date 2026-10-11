#!/usr/bin/env node
/**
 * Private OFFLINE PIT all-member minute-archive receipt, bounded 1-20 names.
 *
 * node market-prediction-lab/scripts/audit-four-market-pit-minute-archive-v1.mjs \
 *  --market CRYPTO_SPOT --day 2025-10-09 \
 *  --manifest /private/historical-roster.json \
 *  --expected-roster-sha <MANIFEST_MEMBERSHIP_DIGEST> \
 *  --root /private/minute-archive --offset 0 --limit 20 \
 *  --output /private/audits/2025-10-09-offset0.json
 *
 * For KR/US, add --stock-calendar /private/day-local-sessions.json.
 * Repeat with nextOffset until null. Historical PIT archive is required;
 * this will never derive one from current ticker lists or today's exchange.
 * This script does NOT GET remote prices, mutate DB, trade, or deploy.
 */
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditHistoricalPITMinuteArchiveChunkV1 } from
  "../src/four-market-pit-minute-archive-join-v1.js";

const KEYS = new Set(["--market", "--day", "--manifest",
  "--expected-roster-sha", "--root", "--offset", "--limit",
  "--stock-calendar", "--output"]);
const REQUIRED = ["--market", "--day", "--manifest",
  "--expected-roster-sha", "--root", "--output"];
const SHA = /^[0-9a-f]{64}$/u;
function safeFile(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
    || (st.mode & 0o077) !== 0 || st.size < 2 || st.size > 64 * 1024 * 1024)
    throw new TypeError("PIT_MINUTE_PRIVATE_SOURCE_FILE_REQUIRED");
  return JSON.parse(readFileSync(path, "utf8"));
}
function safeAncestors(path) {
  let parent = dirname(path);
  while (true) {
    try {
      const st = lstatSync(parent);
      if (!st.isDirectory() || st.isSymbolicLink())
        throw new TypeError("PIT_MINUTE_SYMLINK_PARENT_FORBIDDEN");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
}
export function parsePITMinuteJoinArgsV1(args = []) {
  if (!Array.isArray(args) || args.length < 12 || args.length > 18
    || args.length % 2 !== 0)
    throw new TypeError("PIT_MINUTE_CLI_ARGUMENTS_INVALID");
  const fields = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!KEYS.has(args[i]) || Object.hasOwn(fields, args[i])
      || typeof args[i+1] !== "string" || !args[i+1].trim()
      || args[i+1].startsWith("--"))
      throw new TypeError("PIT_MINUTE_CLI_OPTION_INVALID");
    fields[args[i]] = args[i+1];
  }
  if (!REQUIRED.every(k => Object.hasOwn(fields, k))
    || !SHA.test(fields["--expected-roster-sha"] ?? "")
    || !/^(0|[1-9][0-9]{0,4})$/u.test(fields["--offset"] ?? "0")
    || !/^(?:[1-9]|1[0-9]|20)$/u.test(fields["--limit"] ?? "20"))
    throw new TypeError("PIT_MINUTE_CLI_SCOPE_INVALID");
  const root = fields["--root"], manifest = fields["--manifest"],
    calendar = fields["--stock-calendar"] ?? null,
    output = fields["--output"];
  if (![root,manifest,output,...(calendar == null ? [] : [calendar])]
    .every(x => typeof x === "string" && isAbsolute(x)
      && resolve(x) === x)
    || new Set([root,manifest,output,calendar].filter(Boolean)).size
      !== [root,manifest,output,calendar].filter(Boolean).length)
    throw new TypeError("PIT_MINUTE_CLI_ABSOLUTE_PATH_REQUIRED");
  return Object.freeze({
    market: fields["--market"], day: fields["--day"],
    manifestPath: manifest, expectedRosterDigestSha256:
      fields["--expected-roster-sha"], root,
    stockCalendarPath: calendar,
    offset: Number(fields["--offset"] ?? "0"),
    limit: Number(fields["--limit"] ?? "20"),
    outputPath: output,
  });
}
export async function runPITMinuteJoinCliV1(config) {
  if (!config || !isAbsolute(config.outputPath ?? "")
    || !isAbsolute(config.manifestPath ?? "")
    || !isAbsolute(config.root ?? ""))
    throw new TypeError("PIT_MINUTE_CLI_CONFIG_INVALID");
  try {
    lstatSync(config.outputPath);
    throw new TypeError("PIT_MINUTE_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  safeAncestors(config.outputPath);
  safeAncestors(config.manifestPath);
  if (config.stockCalendarPath) safeAncestors(config.stockCalendarPath);
  const manifest = safeFile(config.manifestPath);
  const stockCalendar = config.stockCalendarPath
    ? safeFile(config.stockCalendarPath) : null;
  const result = await auditHistoricalPITMinuteArchiveChunkV1({
    market: config.market, day: config.day, root: config.root,
    manifest, stockCalendar, offset: config.offset, limit: config.limit,
    expectedRosterDigestSha256: config.expectedRosterDigestSha256,
  });
  safeAncestors(config.outputPath);
  mkdirSync(dirname(config.outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(config.outputPath, JSON.stringify(result, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  return Object.freeze({
    status: result.status, reason: result.reason,
    market: result.market, tradingDate: result.tradingDate,
    inspectedMemberCount: result.inspectedMemberCount ?? null,
    missingSourceMembers: result.missingSourceMembers ?? null,
    nextOffset: result.nextOffset ?? null,
    fullMarketOpportunityDenominatorVerified: false,
    trueMarketWideRecall: null, profitabilityProven: false,
    executionAuthority: "NONE",
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = parsePITMinuteJoinArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(await runPITMinuteJoinCliV1(config)) + "\n");
}
