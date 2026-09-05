// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ScannerUniverseService } from '../../api-server/src/services/scanner-universe.service';
import * as yahoo from '../../api-server/src/providers/yahoo';

const OUTPUT = path.resolve(process.argv[2] ?? 'kr-first-batch-diagnostic.json');
const PROFILES = [
  { profile: 'SCALPING', timeframe: '15m' },
  { profile: 'SWING', timeframe: '60m' },
  { profile: 'MID_LONG', timeframe: '1D' },
];

function sanitize(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s|]+/gu, '[url]').slice(0, 260);
}
function providerCandidates(entry) {
  const symbol = String(entry?.ticker ?? '').trim().toUpperCase();
  const exchange = String(entry?.exchange ?? '').trim().toUpperCase();
  const kosdaq = /KOSDAQ|코스닥/u.test(exchange);
  const primary = `${symbol}.${kosdaq ? 'KQ' : 'KS'}`;
  const alternate = `${symbol}.${kosdaq ? 'KS' : 'KQ'}`;
  return [primary, alternate];
}

async function oneAttempt(providerSymbol, kind, timeframe) {
  const started = Date.now();
  try {
    const value = kind === 'quote'
      ? await yahoo.getQuote(providerSymbol)
      : await yahoo.getCandles(providerSymbol, timeframe);
    return {
      providerSymbol,
      kind,
      timeframe: timeframe ?? null,
      ok: kind === 'quote' ? Number(value?.price ?? 0) > 0 : Array.isArray(value) && value.length > 0,
      elapsedMs: Date.now() - started,
      count: Array.isArray(value) ? value.length : undefined,
      price: kind === 'quote' ? Number(value?.price ?? 0) : undefined,
      error: null,
    };
  } catch (error) {
    return {
      providerSymbol,
      kind,
      timeframe: timeframe ?? null,
      ok: false,
      elapsedMs: Date.now() - started,
      errorName: error instanceof Error ? error.name : 'UNKNOWN',
      error: sanitize(error instanceof Error ? error.message : error),
    };
  }
}

async function probeEntry(entry) {
  const candidates = providerCandidates(entry);
  const profileRows = [];
  for (const profile of PROFILES) {
    const attempts = [];
    for (const providerSymbol of candidates) {
      attempts.push(await oneAttempt(providerSymbol, 'candles', profile.timeframe));
      if (attempts.at(-1)?.ok) break;
    }
    profileRows.push({
      profile: profile.profile,
      timeframe: profile.timeframe,
      ok: attempts.some((row) => row.ok),
      attempts,
    });
  }
  const quoteAttempts = [];
  for (const providerSymbol of candidates) {
    quoteAttempts.push(await oneAttempt(providerSymbol, 'quote'));
    if (quoteAttempts.at(-1)?.ok) break;
  }
  return {
    ticker: String(entry?.ticker ?? ''),
    name: String(entry?.name ?? ''),
    exchange: String(entry?.exchange ?? ''),
    listingStatus: String(entry?.listingStatus ?? ''),
    source: String(entry?.source ?? ''),
    candidates,
    profiles: profileRows,
    quote: { ok: quoteAttempts.some((row) => row.ok), attempts: quoteAttempts },
    fullyReachable: profileRows.every((row) => row.ok) && quoteAttempts.some((row) => row.ok),
  };
}

const universe = await ScannerUniverseService.get('KR');
const entries = Array.isArray(universe?.entries) ? universe.entries.slice(0, 20) : [];
if (entries.length !== 20) throw new Error(`KR_FIRST_BATCH_EXPECTED_20:${entries.length}`);
const rows = [];
for (const entry of entries) rows.push(await probeEntry(entry));

const failures = rows.flatMap((row) => {
  const reasons = [];
  for (const profile of row.profiles) if (!profile.ok) reasons.push(`${profile.profile}:${profile.timeframe}`);
  if (!row.quote.ok) reasons.push('QUOTE');
  return reasons.length ? [{ ticker: row.ticker, name: row.name, exchange: row.exchange, listingStatus: row.listingStatus, reasons }] : [];
});
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  publicOnly: true,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  realOrderAllowed: false,
  universe: {
    totalCount: Number(universe?.totalCount ?? entries.length),
    source: String(universe?.source ?? ''),
    partial: universe?.partial === true,
    stale: universe?.stale === true,
    providerErrorCount: Number(universe?.providerErrorCount ?? 0),
  },
  summary: {
    rows: rows.length,
    fullyReachable: rows.filter((row) => row.fullyReachable).length,
    failedSymbols: failures.length,
  },
  failures,
  rows,
};
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(report.summary, null, 2));
