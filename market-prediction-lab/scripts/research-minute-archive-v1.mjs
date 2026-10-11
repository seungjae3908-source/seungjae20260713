#!/usr/bin/env node
/**
 * Explicit OFFLINE file-to-private-archive and archive-to-timeframe operations.
 *
 * Ingest:
 * node scripts/research-minute-archive-v1.mjs --mode ingest
 *   --root /private/research-minutes --input /private/source-one-session.json
 *
 * Read/derive:
 * node scripts/research-minute-archive-v1.mjs --mode derive
 *   --root /private/research-minutes --market CRYPTO_SPOT --symbol KRW-BTC
 *   --session-start 2026-09-18T00:00:00Z --as-of 2026-09-18T00:15:00Z
 *   --timeframes 1m,3m,5m,15m,1h --output /private/research-result.json
 *
 * No HTTP requests, env secrets, database access, deployment or orders.
 * Neither stored source nor derived bars prove all-market PIT/OOS profitability.
 */
import { lstatSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  persistResearchMinuteSessionV1, deriveArchivedResearchTimeframesV1,
} from "../src/research-minute-archive-v1.js";

const FIELDS = new Set(["--mode", "--root", "--input", "--market", "--symbol",
  "--session-start", "--as-of", "--timeframes", "--output", "--source-digest"]);
function utc(value) {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) {
    throw new TypeError("MINUTE_ARCHIVE_CLI_EXPLICIT_UTC_TIME_REQUIRED");
  }
  const ms = Date.parse(value);
  if (!Number.isSafeInteger(ms) || ms <= 0
    || new Date(ms).toISOString() !== value.replace("Z", ".000Z"))
    throw new TypeError("MINUTE_ARCHIVE_CLI_EXPLICIT_UTC_TIME_REQUIRED");
  return ms;
}
export function parseResearchMinuteArchiveArgsV1(args = []) {
  if (!Array.isArray(args) || args.length < 6 || args.length > 20
    || args.length % 2 !== 0)
    throw new TypeError("MINUTE_ARCHIVE_CLI_ARGUMENTS_INVALID");
  const fields = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!FIELDS.has(key) || Object.hasOwn(fields, key)
      || typeof value !== "string" || !value.trim()
      || value.startsWith("--")) {
      throw new TypeError("MINUTE_ARCHIVE_CLI_OPTION_INVALID");
    }
    fields[key] = value;
  }
  const mode = fields["--mode"];
  const root = fields["--root"];
  if (!["ingest", "derive"].includes(mode)
    || !isAbsolute(root ?? "") || resolve(root) !== root)
    throw new TypeError("MINUTE_ARCHIVE_CLI_MODE_OR_ROOT_INVALID");
  if (mode === "ingest") {
    const inputPath = fields["--input"];
    if (Object.keys(fields).length !== 3
      || !isAbsolute(inputPath ?? "") || resolve(inputPath) === resolve(root))
      throw new TypeError("MINUTE_ARCHIVE_CLI_INGEST_SCOPE_INVALID");
    return Object.freeze({ mode, root, inputPath: resolve(inputPath) });
  }
  const outputPath = fields["--output"];
  const names = fields["--timeframes"]?.split(",") ?? [];
  const required = ["--mode", "--root", "--market", "--symbol",
    "--session-start", "--as-of", "--timeframes", "--output"];
  if (!required.every(k => Object.hasOwn(fields, k))
    || Object.hasOwn(fields, "--input")
    || !isAbsolute(outputPath ?? "") || resolve(outputPath) === resolve(root)
    || names.length < 1 || names.length > 16
    || new Set(names).size !== names.length
    || names.some(s => !s.trim()))
    throw new TypeError("MINUTE_ARCHIVE_CLI_DERIVE_SCOPE_INVALID");
  return Object.freeze({
    mode, root, market: fields["--market"], symbol: fields["--symbol"],
    sessionStartMs: utc(fields["--session-start"]),
    asOfMs: utc(fields["--as-of"]), timeframes: names,
    sourceDigestSha256: fields["--source-digest"] ?? null,
    outputPath: resolve(outputPath),
  });
}
function readPrivateOriginal(path) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1
    || st.size <= 0 || st.size > 3 * 1024 * 1024
    || (st.mode & 0o077) !== 0)
    throw new TypeError("MINUTE_ARCHIVE_CLI_PRIVATE_SOURCE_REQUIRED");
  return JSON.parse(readFileSync(path, "utf8"));
}
export async function runResearchMinuteArchiveCliV1(config) {
  if (!config || !["ingest", "derive"].includes(config.mode))
    throw new TypeError("MINUTE_ARCHIVE_CLI_CONFIG_INVALID");
  if (config.mode === "ingest") {
    const source = readPrivateOriginal(config.inputPath);
    const result = await persistResearchMinuteSessionV1({ root: config.root, source });
    return Object.freeze({
      status: result.status, market: result.market, symbol: result.symbol,
      sessionStartMs: result.sessionStartMs,
      sourceDigestSha256: result.sourceDigestSha256,
      storedOneMinuteRows: result.storedOneMinuteRows,
      wholeHistoricMarketPopulationVerified: false,
      trueMarketWideRecall: null, profitabilityProven: false,
      executionAuthority: "NONE",
    });
  }
  // Never replace an already-created file with private research material.
  try {
    lstatSync(config.outputPath);
    throw new TypeError("MINUTE_ARCHIVE_CLI_OUTPUT_ALREADY_EXISTS");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const result = await deriveArchivedResearchTimeframesV1(config);
  mkdirSync(dirname(config.outputPath), { recursive: true, mode: 0o700 });
  writeFileSync(config.outputPath, JSON.stringify(result, null, 2) + "\n",
    { encoding: "utf8", mode: 0o600, flag: "wx" });
  return Object.freeze({
    status: result.status, reason: result.reason ?? null,
    market: config.market, symbol: config.symbol,
    derivedCandleCount: result.derivedCandleCount ?? 0,
    archiveSourceDigestSha256: result.archiveSourceDigestSha256 ?? null,
    trueMarketWideRecall: null, profitabilityProven: false,
    executionAuthority: "NONE",
  });
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = parseResearchMinuteArchiveArgsV1(process.argv.slice(2));
  process.stdout.write(JSON.stringify(await runResearchMinuteArchiveCliV1(config)) + "\n");
}
