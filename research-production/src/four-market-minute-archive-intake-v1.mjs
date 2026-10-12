// Research-only 1m source intake. OFF unless called with enabled:true.
// Historical source availability is the actual fetch time, NEVER candle time.
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, link, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

export const MINUTE_MS = 60_000;
export const MINUTE_ARCHIVE_CONTRACT = 'four-market-original-minute-public-intake/v1';
export const MINUTE_ARCHIVE_LIMITS = Object.freeze({
  maxTasks: 16, maxWindowMinutes: 120, maxResponseBytes: 512 * 1024,
  maxArchiveBytes: 512 * 1024, minFreeBytes: 5 * 1024 ** 3,
  networkTimeoutMs: 8_000, minRequestIntervalMs: 300,
});
const MARKETS = new Set(['KR_STOCK', 'US_STOCK', 'CRYPTO_SPOT', 'CRYPTO_FUTURES']);
const UPBIT = 'UPBIT_PUBLIC_1M';
const BITGET = 'BITGET_PUBLIC_FUTURES_1M';
const SOURCE = Object.freeze({ CRYPTO_SPOT: UPBIT, CRYPTO_FUTURES: BITGET });
const SHA40 = /^[0-9a-f]{40}$/u;
const HASH64 = /^[0-9a-f]{64}$/u;
const POSIX_PRIVATE = 0o077;
const PRICE_FIELDS = ['open', 'high', 'low', 'close'];

const fail = (code) => { throw new Error(code); };
const integer = n => Number.isSafeInteger(n) && n > 0;
const sha256 = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const isObject = v => v && typeof v === 'object' && !Array.isArray(v);

export function validateMinuteTask(raw) {
  if (!isObject(raw) || !MARKETS.has(raw.market)) fail('MINUTE_MARKET_INVALID');
  const symbol = String(raw.symbol ?? '').trim().toUpperCase();
  const rule = raw.market === 'KR_STOCK' ? /^[A-Z0-9]{6}$/u
    : raw.market === 'US_STOCK' ? /^[A-Z][A-Z0-9]{0,14}(?:[.-][A-Z0-9]{1,6})?$/u
    : raw.market === 'CRYPTO_SPOT' ? /^[A-Z0-9]{1,20}$/u
    : /^[A-Z0-9]{3,30}$/u;
  if (!rule.test(symbol) || symbol !== raw.symbol) fail('MINUTE_SYMBOL_INVALID');
  const { windowStartMs: start, windowEndMs: end } = raw;
  if (!integer(start) || !integer(end) || start % MINUTE_MS || end % MINUTE_MS
    || end <= start || end - start > MINUTE_ARCHIVE_LIMITS.maxWindowMinutes * MINUTE_MS)
    fail('MINUTE_WINDOW_INVALID');
  return Object.freeze({ market: raw.market, symbol, windowStartMs: start, windowEndMs: end });
}

function number(value) {
  if (typeof value !== 'number' && typeof value !== 'string') fail('MINUTE_FIELD_INVALID');
  if (String(value).trim() === '') fail('MINUTE_FIELD_INVALID');
  const n = Number(value);
  if (!Number.isFinite(n)) fail('MINUTE_FIELD_INVALID');
  return n;
}
function normRow(raw) {
  const row = {
    timestamp: number(raw.timestamp),
    open: number(raw.open), high: number(raw.high), low: number(raw.low),
    close: number(raw.close), volume: number(raw.volume),
    quoteVolume: raw.quoteVolume == null ? null : number(raw.quoteVolume),
  };
  if (!integer(row.timestamp) || row.timestamp % MINUTE_MS !== 0
    || PRICE_FIELDS.some(k => row[k] <= 0) || row.volume < 0
    || (row.quoteVolume != null && row.quoteVolume < 0)
    || row.high < Math.max(row.open, row.close)
    || row.low > Math.min(row.open, row.close) || row.high < row.low)
    fail('MINUTE_OHLCV_INVALID');
  return Object.freeze(row);
}
export function validateMinuteCandles(task, rawRows, collectedAtMs) {
  if (!Array.isArray(rawRows) || rawRows.length > 200 || !integer(collectedAtMs))
    fail('MINUTE_SOURCE_SHAPE_INVALID');
  if (task.windowEndMs > collectedAtMs - 5_000) fail('MINUTE_WINDOW_NOT_CLOSED');
  const candles = rawRows.map(normRow).sort((a,b) => a.timestamp - b.timestamp);
  for (let i=0; i<candles.length; i++) {
    const c = candles[i];
    if (c.timestamp < task.windowStartMs || c.timestamp >= task.windowEndMs
      || c.timestamp + MINUTE_MS > collectedAtMs - 5_000)
      fail('MINUTE_SOURCE_OUT_OF_WINDOW');
    if (i && candles[i-1].timestamp === c.timestamp)
      fail('MINUTE_DUPLICATE_CANDLE');
  }
  // Upbit may legitimately omit no-trade minutes. Never fabricate zero-volume bars.
  return Object.freeze(candles);
}

async function boundedJson(response) {
  const length = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(length) && length > MINUTE_ARCHIVE_LIMITS.maxResponseBytes)
    fail('MINUTE_SOURCE_RESPONSE_OVERSIZE');
  let bytes;
  if (typeof response.body?.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MINUTE_ARCHIVE_LIMITS.maxResponseBytes) {
          await reader.cancel();
          fail('MINUTE_SOURCE_RESPONSE_OVERSIZE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally { reader.releaseLock(); }
    bytes = Buffer.concat(chunks);
  } else {
    const text = await response.text();
    bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength > MINUTE_ARCHIVE_LIMITS.maxResponseBytes)
      fail('MINUTE_SOURCE_RESPONSE_OVERSIZE');
  }
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { fail('MINUTE_SOURCE_JSON_INVALID'); }
}
function upbitUtcStart(raw) {
  const s = raw?.candle_date_time_utc;
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00$/u.test(s))
    fail('MINUTE_UPBIT_START_INVALID');
  const t = Date.parse(s + 'Z');
  if (!integer(t) || new Date(t).toISOString().slice(0,19) !== s)
    fail('MINUTE_UPBIT_START_INVALID');
  return t;
}
export function normalizePublicMinuteResponse(task, body) {
  const rows = task.market === 'CRYPTO_SPOT' ? body
    : task.market === 'CRYPTO_FUTURES' && body?.code === '00000' ? body.data : null;
  if (!Array.isArray(rows) || rows.length > 200) fail('MINUTE_SOURCE_RESPONSE_INVALID');
  const candles = rows.map(row => {
    if (task.market === 'CRYPTO_SPOT') {
      if (!isObject(row) || row.market !== 'KRW-' + task.symbol)
        fail('MINUTE_UPBIT_MARKET_MISMATCH');
      return { timestamp: upbitUtcStart(row), open: row.opening_price,
        high: row.high_price, low: row.low_price, close: row.trade_price,
        volume: row.candle_acc_trade_volume, quoteVolume: row.candle_acc_trade_price };
    }
    if (!Array.isArray(row) || row.length < 7) fail('MINUTE_BITGET_ROW_INVALID');
    return { timestamp: row[0], open: row[1], high: row[2],
      low: row[3], close: row[4], volume: row[5], quoteVolume: row[6] };
  });
  // Bitget can return an extra interval at a rounded boundary; older Upbit
  // candles outside the selected 120-minute window are also not imported.
  for (const row of candles) {
    const t = Number(row.timestamp);
    if (!integer(t) || t % MINUTE_MS) fail('MINUTE_SOURCE_TIMESTAMP_INVALID');
  }
  return candles.filter(row => {
    const t = Number(row.timestamp);
    return t >= task.windowStartMs && t < task.windowEndMs;
  });
}
export async function fetchCryptoMinutePage(task, {
  fetchImpl = globalThis.fetch, timeoutMs = MINUTE_ARCHIVE_LIMITS.networkTimeoutMs,
} = {}) {
  if (!SOURCE[task.market]) fail('MINUTE_STOCK_FEED_NOT_CONFIGURED');
  if (typeof fetchImpl !== 'function') fail('MINUTE_FETCH_UNAVAILABLE');
  const url = new URL(task.market === 'CRYPTO_SPOT'
    ? 'https://api.upbit.com/v1/candles/minutes/1'
    : 'https://api.bitget.com/api/v2/mix/market/history-candles');
  if (task.market === 'CRYPTO_SPOT') {
    url.searchParams.set('market', 'KRW-' + task.symbol);
    url.searchParams.set('to', new Date(task.windowEndMs).toISOString());
    url.searchParams.set('count', '200');
  } else {
    url.searchParams.set('symbol', task.symbol);
    url.searchParams.set('productType', 'USDT-FUTURES');
    url.searchParams.set('granularity', '1m');
    url.searchParams.set('startTime', String(task.windowStartMs - MINUTE_MS));
    url.searchParams.set('endTime', String(task.windowEndMs));
    url.searchParams.set('limit', '200');
  }
  if (!integer(timeoutMs) || timeoutMs > 15_000) fail('MINUTE_HTTP_TIMEOUT_INVALID');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    try {
      const response = await fetchImpl(url.toString(), {
        method: 'GET', redirect: 'error', signal: controller.signal,
        headers: { accept: 'application/json' },
      });
      if (!response || response.ok !== true)
        fail('MINUTE_SOURCE_HTTP_' + (Number.isSafeInteger(response?.status) ? response.status : 'ERROR'));
      const parsed = await boundedJson(response);
      return normalizePublicMinuteResponse(task, parsed);
    } catch (e) {
      if (controller.signal.aborted) fail('MINUTE_SOURCE_TIMEOUT');
      if (/^MINUTE_[A-Z0-9_]{1,80}$/u.test(e?.message ?? '')) throw e;
      fail('MINUTE_SOURCE_NETWORK_UNAVAILABLE');
    }
  } finally { clearTimeout(timer); }
}

// Reject aliased ancestors, not just the final storage directory. This
// must run before any write and each independent archive read.
async function unlinkedAncestors(path) {
  let part = path;
  while (true) {
    const info = await lstat(part);
    if (info.isSymbolicLink()) fail('MINUTE_ARCHIVE_ANCESTOR_SYMLINK');
    const parent = dirname(part);
    if (parent === part) break;
    part = parent;
  }
}
async function privateDirectory(path, create = false) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & POSIX_PRIVATE))
    fail('MINUTE_ARCHIVE_DIRECTORY_UNSAFE');
}
function archiveFile(root, task) {
  const date = new Date(task.windowStartMs).toISOString().slice(0,10);
  return join(root, task.market, task.symbol, date,
    String(task.windowStartMs) + '-' + String(task.windowEndMs) + '.json');
}
async function privateArchiveFile(path) {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1
      || (info.mode & POSIX_PRIVATE) || info.size < 1
      || info.size > MINUTE_ARCHIVE_LIMITS.maxArchiveBytes)
      fail('MINUTE_ARCHIVE_FILE_UNSAFE');
    return await handle.readFile('utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error?.code === 'ELOOP') fail('MINUTE_ARCHIVE_FILE_UNSAFE');
    throw error;
  } finally {
    await handle?.close();
  }
}
function candleDigest(record) {
  // Same observed candles remain reusable across code releases; the original
  // producer SHA is separately sealed by contentDigest and never rewritten.
  return sha256([record.contract, record.market, record.symbol,
    record.source, record.windowStartMs, record.windowEndMs, record.candles]);
}
function contentDigest(record) {
  // Bind original receipt time, never backdate candle availability.
  return sha256([candleDigest(record), record.retrievedAt,
    record.missingMinutesUnclassified, record.genuinePastAvailabilityUnproven,
    record.fullMarketCoverageProven, record.economicEvidenceCredit,
    record.oosCredit, record.paperCredit, record.profitabilityProven,
    record.executionAuthority]);
}
export async function readOriginalMinutePage(root, task, researchSha) {
  if (!SHA40.test(researchSha ?? '') || !isAbsolute(root ?? ''))
    fail('MINUTE_ARCHIVE_CONFIGURATION_INVALID');
  const scope = validateMinuteTask(task);
  if (!SOURCE[scope.market]) fail('MINUTE_STOCK_FEED_NOT_CONFIGURED');
  const base = resolve(root);
  if (/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(base))
    fail('MINUTE_ARCHIVE_APP_ROOT_FORBIDDEN');
  await unlinkedAncestors(base);
  await privateDirectory(base);
  for (const part of [join(base, scope.market),
    join(base, scope.market, scope.symbol),
    join(base, scope.market, scope.symbol,
      new Date(scope.windowStartMs).toISOString().slice(0,10))]) {
    try { await privateDirectory(part); }
    catch (e) { if (e?.code === 'ENOENT') return null; throw e; }
  }
  const file = archiveFile(base, scope);
  const data = await privateArchiveFile(file);
  if (data === null) return null;
  let row;
  try { row = JSON.parse(data); } catch { fail('MINUTE_ARCHIVE_CORRUPT'); }
  if (row?.contract !== MINUTE_ARCHIVE_CONTRACT || !SHA40.test(row.researchSha ?? '')
    || row.market !== task.market || row.symbol !== task.symbol
    || row.source !== SOURCE[task.market] || row.windowStartMs !== task.windowStartMs
    || row.windowEndMs !== task.windowEndMs || !HASH64.test(row.contentDigest ?? '')
    || row.contentDigest !== contentDigest(row)
    || row.candleDigest !== candleDigest(row)
    || row.missingMinutesUnclassified !== true
    || row.genuinePastAvailabilityUnproven !== true
    || row.fullMarketCoverageProven !== false
    || row.economicEvidenceCredit !== 0
    || !Array.isArray(row.candles) || row.candles.length === 0
    || row.candleCount !== row.candles.length
    || row.executionAuthority !== 'NONE' || row.oosCredit !== 0
    || row.paperCredit !== 0 || row.profitabilityProven !== false)
    fail('MINUTE_ARCHIVE_CORRUPT');
  validateMinuteCandles(task, row.candles, Date.parse(row.retrievedAt));
  return Object.freeze(row);
}
async function fsyncDirectory(path) {
  const dir = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await dir.sync(); } finally { await dir.close(); }
}
export async function persistOriginalMinutePage({
  root, task, researchSha, rows, retrievedAtMs,
} = {}) {
  if (!SHA40.test(researchSha ?? '') || !isAbsolute(root ?? ''))
    fail('MINUTE_ARCHIVE_CONFIGURATION_INVALID');
  const scope = validateMinuteTask(task);
  if (!SOURCE[scope.market]) fail('MINUTE_STOCK_FEED_NOT_CONFIGURED');
  const base = resolve(root);
  if (/^\/(?:opt\/stock-app-data|srv\/stock-app|var\/lib\/stock-app)(?:\/|$)/u.test(base))
    fail('MINUTE_ARCHIVE_APP_ROOT_FORBIDDEN');
  await unlinkedAncestors(base);
  await privateDirectory(base);
  const candles = validateMinuteCandles(scope, rows, retrievedAtMs);
  if (!candles.length) return Object.freeze({ status: 'BLOCKED_EMPTY_RESPONSE', archived: false });
  const dirs = [join(base, scope.market), join(base, scope.market, scope.symbol),
    join(base, scope.market, scope.symbol, new Date(scope.windowStartMs).toISOString().slice(0,10))];
  for (const dir of dirs) await privateDirectory(dir, true);
  const path = archiveFile(base, scope);
  const record = {
    contract: MINUTE_ARCHIVE_CONTRACT, researchSha, market: scope.market,
    symbol: scope.symbol, source: SOURCE[scope.market],
    windowStartMs: scope.windowStartMs, windowEndMs: scope.windowEndMs,
    retrievedAt: new Date(retrievedAtMs).toISOString(), candleCount: candles.length,
    candles, missingMinutesUnclassified: true, genuinePastAvailabilityUnproven: true,
    fullMarketCoverageProven: false, economicEvidenceCredit: 0,
    oosCredit: 0, paperCredit: 0, profitabilityProven: false, executionAuthority: 'NONE',
  };
  record.candleDigest = candleDigest(record);
  record.contentDigest = contentDigest(record);
  const existing = await readOriginalMinutePage(base, scope, researchSha);
  if (existing) {
    if (existing.candleDigest !== record.candleDigest) fail('MINUTE_ARCHIVE_SOURCE_CONFLICT');
    return Object.freeze({ status: 'REUSED_IDENTICAL', archived: true,
      candleCount: existing.candleCount, contentDigest: existing.contentDigest });
  }
  const temporary = join(dirs.at(-1), '.minute-tmp-' + randomUUID());
  let linked = false;
  try {
    const fd = await open(temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      const bytes = Buffer.from(JSON.stringify(record) + '\n');
      if (bytes.length > MINUTE_ARCHIVE_LIMITS.maxArchiveBytes)
        fail('MINUTE_ARCHIVE_PAGE_OVERSIZE');
      await fd.writeFile(bytes);
      await fd.sync();
    } finally { await fd.close(); }
    try { await link(temporary, path); linked = true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const rival = await readOriginalMinutePage(base, scope, researchSha);
      if (!rival || rival.candleDigest !== record.candleDigest)
        fail('MINUTE_ARCHIVE_SOURCE_CONFLICT');
    }
    // First fsync makes the immutable new name durable; second one removes
    // the temporary hardlink. On crash a link-count=2 file remains BLOCKED.
    await fsyncDirectory(dirs.at(-1));
  } finally {
    await unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; });
    if (linked) await fsyncDirectory(dirs.at(-1));
  }
  const readback = await readOriginalMinutePage(base, scope, researchSha);
  if (!readback || readback.candleDigest !== record.candleDigest)
    fail('MINUTE_ARCHIVE_READBACK_FAILED');
  return Object.freeze({ status: linked ? 'ARCHIVED' : 'REUSED_IDENTICAL',
    archived: true, candleCount: readback.candleCount, contentDigest: readback.contentDigest });
}

export async function runMinuteArchiveIntakeV1({
  enabled = false, root, tasks = [], researchSha, now = () => Date.now(),
  fetchImpl = globalThis.fetch, sleep = ms => new Promise(r => setTimeout(r, ms)),
  freeBytes = null,
} = {}) {
  if (!enabled) return Object.freeze({ status: 'DISABLED', providerCalls: 0,
    filesWritten: 0, executionAuthority: 'NONE' });
  if (!SHA40.test(researchSha ?? '') || !Array.isArray(tasks) || !tasks.length
    || tasks.length > MINUTE_ARCHIVE_LIMITS.maxTasks
    || !isAbsolute(root ?? '')) fail('MINUTE_INTAKE_CONFIG_INVALID');
  const scopes = tasks.map(validateMinuteTask);
  if (new Set(scopes.map(s => JSON.stringify(s))).size !== scopes.length)
    fail('MINUTE_INTAKE_DUPLICATE_TASK');
  await unlinkedAncestors(resolve(root));
  await privateDirectory(resolve(root));
  if (freeBytes != null && (!Number.isSafeInteger(freeBytes)
    || freeBytes < MINUTE_ARCHIVE_LIMITS.minFreeBytes))
    return Object.freeze({ status: 'HOLD_DISK', providerCalls: 0,
      filesWritten: 0, executionAuthority: 'NONE' });
  let providerCalls = 0, filesWritten = 0;
  const results = [];
  for (const task of scopes) {
    if (!SOURCE[task.market]) {
      results.push({ market: task.market, symbol: task.symbol,
        status: 'BLOCKED_STOCK_FEED_NOT_CONFIGURED' });
      continue;
    }
    try {
      const existing = await readOriginalMinutePage(resolve(root), task, researchSha);
      if (existing) {
        results.push({ market: task.market, symbol: task.symbol,
          status: 'REUSED_IDENTICAL', candleCount: existing.candleCount });
        continue;
      }
      const observedAt = now();
      if (!integer(observedAt) || task.windowEndMs > observedAt - 5_000)
        fail('MINUTE_WINDOW_NOT_CLOSED');
      providerCalls++;
      const rows = await fetchCryptoMinutePage(task, { fetchImpl });
      const receipt = await persistOriginalMinutePage({
        root, task, researchSha, rows, retrievedAtMs: now(),
      });
      if (receipt.status === 'ARCHIVED') filesWritten++;
      results.push({ market: task.market, symbol: task.symbol, status: receipt.status,
        candleCount: receipt.candleCount ?? 0 });
    } catch (e) {
      // Safe stable errors only; do not log URLs, provider payload, tokens or paths.
      const code = String(e?.message ?? '').match(/^MINUTE_[A-Z0-9_]{1,80}$/u)?.[0]
        ?? 'MINUTE_INTAKE_OPERATION_FAILED';
      results.push({ market: task.market, symbol: task.symbol, status: 'BLOCKED', error: code });
    }
    if (providerCalls < scopes.length) await sleep(MINUTE_ARCHIVE_LIMITS.minRequestIntervalMs);
  }
  return Object.freeze({ status: results.every(r => r.status === 'ARCHIVED'
      || r.status === 'REUSED_IDENTICAL') ? 'ARCHIVED_OR_REUSED' : 'PARTIAL_OR_BLOCKED',
    providerCalls, filesWritten, results, executionAuthority: 'NONE',
    fourMarketCoverageProven: false, profitabilityProven: false });
}
