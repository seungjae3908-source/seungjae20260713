// @ts-nocheck
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const OUTPUT = path.resolve(process.argv[2] ?? 'kr-yahoo-provider-diagnostic.json');
const SYMBOLS = ['005930', '000660', '035420', '005380', '068270'];
const PROFILES = [
  { profile: 'SCALPING', range: '1mo', interval: '15m' },
  { profile: 'SWING', range: '2y', interval: '60m' },
  { profile: 'MID_LONG', range: '10y', interval: '1d' },
  { profile: 'QUOTE', range: '1mo', interval: '1d' },
];
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const HARD_TIMEOUT_MS = 8_000;

function sanitize(value) {
  return String(value ?? '').replace(/https?:\/\/[^\s|]+/gu, '[url]').slice(0, 240);
}

async function probe(host, symbol, profile) {
  const providerSymbol = `${symbol}.KS`;
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(providerSymbol)}?range=${profile.range}&interval=${profile.interval}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error('DIAGNOSTIC_TIMEOUT')), HARD_TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        accept: 'application/json,text/plain,*/*',
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      },
    });
    const elapsedMs = Date.now() - started;
    let json = null;
    let parseError = null;
    try { json = await response.json(); } catch (error) { parseError = sanitize(error instanceof Error ? error.message : error); }
    const result = json?.chart?.result?.[0];
    const quote = result?.indicators?.quote?.[0];
    const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
    const closes = Array.isArray(quote?.close) ? quote.close.filter((v) => Number.isFinite(Number(v))) : [];
    return {
      symbol,
      providerSymbol,
      profile: profile.profile,
      host,
      httpStatus: response.status,
      ok: response.ok && Boolean(quote) && timestamps.length > 0 && closes.length > 0,
      elapsedMs,
      timestampCount: timestamps.length,
      validCloseCount: closes.length,
      chartErrorCode: sanitize(json?.chart?.error?.code ?? ''),
      chartErrorDescription: sanitize(json?.chart?.error?.description ?? ''),
      parseError,
    };
  } catch (error) {
    return {
      symbol,
      providerSymbol,
      profile: profile.profile,
      host,
      httpStatus: null,
      ok: false,
      elapsedMs: Date.now() - started,
      errorName: error instanceof Error ? error.name : 'UNKNOWN',
      error: sanitize(error instanceof Error ? error.message : error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

const rows = [];
for (const symbol of SYMBOLS) {
  for (const profile of PROFILES) {
    for (const host of HOSTS) rows.push(await probe(host, symbol, profile));
  }
}

const summary = {
  total: rows.length,
  ok: rows.filter((row) => row.ok).length,
  failed: rows.filter((row) => !row.ok).length,
  query1Ok: rows.filter((row) => row.host.startsWith('query1') && row.ok).length,
  query2Ok: rows.filter((row) => row.host.startsWith('query2') && row.ok).length,
  under1650ms: rows.filter((row) => row.ok && row.elapsedMs <= 1650).length,
  under3500ms: rows.filter((row) => row.ok && row.elapsedMs <= 3500).length,
  over3500ms: rows.filter((row) => row.ok && row.elapsedMs > 3500).length,
};

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  publicOnly: true,
  executionAuthority: 'NONE',
  privateApiAllowed: false,
  realOrderAllowed: false,
  hardTimeoutMs: HARD_TIMEOUT_MS,
  summary,
  rows,
};
await mkdir(path.dirname(OUTPUT), { recursive: true });
await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary, null, 2));
