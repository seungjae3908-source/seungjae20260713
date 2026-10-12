import { createHash } from "node:crypto";

/**
 * Explicit, bounded historical market-data reads only. No environment lookup,
 * account/order endpoint, filesystem write, implicit ticker mapping or IEX
 * fallback. Official API bounds are inclusive bar-start timestamps:
 * https://docs.alpaca.markets/us/reference/stockbars
 * Daily bars start at New York midnight, including its DST offset:
 * https://docs.alpaca.markets/us/docs/market-data-faq
 */
const ENDPOINT = "https://data.alpaca.markets/v2/stocks/bars";
const MINUTE = 60_000;
const DAY = 86_400_000;
const LAG = 15 * MINUTE;
const MAX_PAGE_ROWS = 10_000;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const PAGE_TIMEOUT_MS = 12_000;
const SYMBOL = /^[A-Z0-9][A-Z0-9.\-/:^]{0,39}$/u;
const BAR_KEYS = new Set(["t", "o", "h", "l", "c", "v", "n", "vw"]);
const REQUIRED_BAR_KEYS = ["t", "o", "h", "l", "c", "v"];
const eastern = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit",
  day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23",
});
const hash = value => createHash("sha256").update(value).digest("hex");
const object = value => value !== null && typeof value === "object"
  && !Array.isArray(value);
const safeIntegerTime = value => Number.isSafeInteger(value) && value > 0
  && value <= 8_640_000_000_000_000;
const credential = value => typeof value === "string" && value.length <= 512
  && /^[\x21-\x7e]+$/u.test(value);
const proofLimits = Object.freeze({
  sourceLimited: true, cohortScope: "EXPLICIT_REQUESTED_SYMBOLS_ONLY",
  historicalUniverseComplete: false, sourceArchiveCompletenessProven: false,
  permanentShareClassIdentityVerified: false, corporateActionsVerified: false,
  fullMarketOpportunityDenominatorVerified: false, missingMinuteNoTradeProof: false,
  sourceLicenseAndReuseRightsIndependentlyVerified: false,
  sourceRedistributionAllowed: false, trueMarketWideRecall: null,
  actualMarketWideOpportunityCount: null, actualFillCount: null, netProfitPct: null,
  OOSPassCount: 0, profitabilityProven: false, paperAdmissionAllowed: false,
  executionAuthority: "NONE", liveTrading: false, autoTrading: false,
  realOrders: false,
});

function strictTime(value, barTimestamp = false) {
  if (!barTimestamp && typeof value === "number") {
    return safeIntegerTime(value) ? value : null;
  }
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2}))?$/u.exec(value);
  if (!match || barTimestamp && !match[4]) return null;
  const [, year, month, day, hour = "00", minute = "00", second = "00",
    fraction = "", zone = "Z"] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number);
  if (y < 1970 || mo < 1 || mo > 12 || d < 1 || h > 23 || mi > 59 || s > 59
    || /[1-9]/u.test(fraction.slice(3))) return null;
  const local = Date.UTC(y, mo - 1, d, h, mi, s, Number(fraction.slice(0, 3).padEnd(3, "0")));
  const localDate = new Date(local);
  if (localDate.getUTCFullYear() !== y || localDate.getUTCMonth() !== mo - 1
    || localDate.getUTCDate() !== d) return null;
  let offset = 0;
  if (zone !== "Z") {
    const hours = Number(zone.slice(1, 3)), minutes = Number(zone.slice(4, 6));
    if (hours > 23 || minutes > 59) return null;
    offset = (zone[0] === "+" ? 1 : -1) * (hours * 60 + minutes) * MINUTE;
  }
  const result = local - offset;
  return safeIntegerTime(result) ? result : null;
}

function easternParts(timestamp) {
  const parts = Object.fromEntries(eastern.formatToParts(new Date(timestamp))
    .filter(part => part.type !== "literal").map(part => [part.type, Number(part.value)]));
  return parts;
}

function dailyEnd(timestamp) {
  const p = easternParts(timestamp);
  if (timestamp % 1000 !== 0 || p.hour !== 0 || p.minute !== 0 || p.second !== 0) return null;
  const targetWall = Date.UTC(p.year, p.month - 1, p.day + 1);
  const guess = timestamp + DAY, g = easternParts(guess);
  const actualWall = Date.UTC(g.year, g.month - 1, g.day, g.hour, g.minute, g.second);
  const end = guess + targetWall - actualWall, e = easternParts(end);
  return e.hour === 0 && e.minute === 0 && e.second === 0
    && Date.UTC(e.year, e.month - 1, e.day) === targetWall ? end : null;
}

function normalizeBar(row, symbol, timeframe, start, end, observedAt) {
  if (!object(row) || REQUIRED_BAR_KEYS.some(key => !Object.hasOwn(row, key))
    || Object.keys(row).some(key => !BAR_KEYS.has(key))) {
    return { reason: "ALPACA_BAR_SCHEMA_INVALID" };
  }
  const timestamp = strictTime(row.t, true);
  if (timestamp === null || timeframe === "1Min" && timestamp % MINUTE !== 0) {
    return { reason: "ALPACA_BAR_TIMESTAMP_INVALID" };
  }
  const barEndTimeMs = timeframe === "1Min" ? timestamp + MINUTE : dailyEnd(timestamp);
  if (barEndTimeMs === null) return { reason: "ALPACA_DAILY_BAR_BOUNDARY_INVALID" };
  if (timestamp < start || timestamp > end) return { reason: "ALPACA_BAR_OUTSIDE_REQUEST" };
  if (barEndTimeMs > observedAt) return { reason: "ALPACA_BAR_NOT_CLOSED" };
  if (![row.o, row.h, row.l, row.c].every(value =>
    typeof value === "number" && Number.isFinite(value) && value > 0)
    || typeof row.v !== "number" || !Number.isFinite(row.v) || row.v < 0
    || row.h < Math.max(row.o, row.l, row.c)
    || row.l > Math.min(row.o, row.h, row.c)
    || Object.hasOwn(row, "n") && (!Number.isSafeInteger(row.n) || row.n < 0)
    || Object.hasOwn(row, "vw") && (typeof row.vw !== "number"
      || !Number.isFinite(row.vw) || row.vw <= 0)) {
    return { reason: "ALPACA_BAR_OHLCV_INVALID" };
  }
  return {
    raw: Object.freeze({ ...row }),
    canonical: Object.freeze({
      symbol, market: "US_STOCK", venue: "US_SIP", feed: "sip", currency: "USD",
      timeframe, timestamp, barStartTimeMs: timestamp, barEndTimeMs,
      open: row.o, high: row.h, low: row.l, close: row.c, volume: row.v,
      tradeCount: row.n ?? null, vwap: row.vw ?? null,
    }),
  };
}

function transportReason(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return "ALPACA_SOURCE_TIMEOUT";
  }
  const codes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED",
    "ETIMEDOUT", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ERR_TLS_CERT_ALTNAME_INVALID",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "DEPTH_ZERO_SELF_SIGNED_CERT"]);
  if (codes.has(error?.code) || codes.has(error?.cause?.code)
    || error instanceof TypeError
      && /^(?:fetch failed|Failed to fetch|NetworkError when attempting to fetch resource\.)$/u.test(error.message)) {
    return "ALPACA_SOURCE_NETWORK_ERROR";
  }
  return null;
}

class AlpacaBodyReadFailure extends Error {
  constructor(reason) {
    super(reason);
    this.reason = reason;
  }
}

async function withBodyAbort(operation, signal) {
  let onAbort;
  const aborted = new Promise((resolve, reject) => {
    onAbort = () => reject(new AlpacaBodyReadFailure("ALPACA_SOURCE_TIMEOUT"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    // Use a fresh listener for each read so tiny chunks cannot accumulate
    // unresolved race handlers on one shared deadline promise.
    signal.removeEventListener("abort", onAbort);
  }
}

async function readBoundedResponseBytes(response, signal, deadline) {
  if (!response.body || typeof response.body.getReader !== "function") {
    throw new AlpacaBodyReadFailure("ALPACA_RESPONSE_BODY_STREAM_REQUIRED");
  }
  const reader = response.body.getReader();
  if (!reader || typeof reader.read !== "function" || typeof reader.cancel !== "function"
    || typeof reader.releaseLock !== "function") {
    throw new TypeError("ALPACA_RESPONSE_READER_IMPLEMENTATION_INVALID");
  }
  const timedOut = () => signal.aborted || performance.now() >= deadline;
  try {
    if (timedOut()) throw new AlpacaBodyReadFailure("ALPACA_SOURCE_TIMEOUT");
    // A missing length is permitted for chunked responses. A declared length is
    // checked before the first read; the stream cap also applies after decoding
    // transport compression, so a short compressed Content-Length cannot bypass it.
    const declared = response.headers == null ? null : response.headers.get("content-length");
    if (declared !== null && declared !== undefined) {
      if (typeof declared !== "string" || !/^\d+$/u.test(declared)) {
        throw new AlpacaBodyReadFailure("ALPACA_RESPONSE_CONTENT_LENGTH_INVALID");
      }
      if (Number(declared) > MAX_BODY_BYTES) {
        throw new AlpacaBodyReadFailure("ALPACA_RESPONSE_SIZE_LIMIT_EXCEEDED");
      }
    }
    // One fixed buffer also bounds bookkeeping memory for many tiny chunks.
    const bytes = Buffer.allocUnsafe(MAX_BODY_BYTES);
    let length = 0;
    for (;;) {
      if (timedOut()) throw new AlpacaBodyReadFailure("ALPACA_SOURCE_TIMEOUT");
      // Some injected streams do not inherit fetch's signal. Race the entire
      // body against the same page deadline, including a stalled pending read.
      const part = await withBodyAbort(reader.read(), signal);
      if (timedOut()) throw new AlpacaBodyReadFailure("ALPACA_SOURCE_TIMEOUT");
      if (!object(part) || typeof part.done !== "boolean") {
        throw new AlpacaBodyReadFailure("ALPACA_RESPONSE_BODY_CHUNK_INVALID");
      }
      if (part.done) return Buffer.from(bytes.subarray(0, length));
      if (!(part.value instanceof Uint8Array)) {
        throw new AlpacaBodyReadFailure("ALPACA_RESPONSE_BODY_CHUNK_INVALID");
      }
      if (part.value.byteLength > MAX_BODY_BYTES - length) {
        throw new AlpacaBodyReadFailure("ALPACA_RESPONSE_SIZE_LIMIT_EXCEEDED");
      }
      // Copy only bounded byte chunks, before a custom stream can reuse them.
      bytes.set(part.value, length);
      length += part.value.byteLength;
    }
  } catch (error) {
    try {
      // Cancellation is bounded by the original deadline too. Expected source
      // failures during cancellation must not replace the original failure.
      await withBodyAbort(reader.cancel(), signal);
    } catch (cancelError) {
      if (!(cancelError instanceof AlpacaBodyReadFailure) && !transportReason(cancelError)) {
        throw cancelError;
      }
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function httpReason(status) {
  if (status === 401) return "ALPACA_AUTHENTICATION_REJECTED";
  if (status === 403) return "ALPACA_SIP_ENTITLEMENT_OR_AUTHORIZATION_DENIED";
  if (status === 429) return "ALPACA_RATE_LIMITED";
  if (status >= 300 && status < 400) return "ALPACA_REDIRECT_REJECTED";
  if (status >= 500) return "ALPACA_SOURCE_UNAVAILABLE";
  return "ALPACA_DATA_REQUEST_REJECTED";
}

export async function collectAlpacaHistoricalBarsV1({
  symbols, startTime, endTime, timeframe = "1Min", apiKey = null, apiSecret = null,
  allowHistoricalDataRead = false, fetchImpl = globalThis.fetch,
  nowImpl = () => Date.now(), maxPages = 8,
} = {}) {
  let selected = [], requestedInterval = null, observedAtMs = null;
  let providerReadOnlyGETs = 0, paginationComplete = false, pageCount = 0;
  let retainedBarCount = 0, rawRowCount = 0, duplicateRowCount = 0;
  let firstBarStartTimeMs = null, lastBarStartTimeMs = null, lastBarEndTimeMs = null;
  const rawPages = [], rawBySymbol = new Map(), canonicalBySymbol = new Map();
  const report = (status, reason, extra = {}) => {
    const barsBySymbol = Object.freeze(Object.fromEntries(selected.map(symbol =>
      [symbol, Object.freeze([...(canonicalBySymbol.get(symbol)?.values() ?? [])])])));
    const rawRowsBySymbol = Object.freeze(Object.fromEntries(selected.map(symbol =>
      [symbol, Object.freeze([...(rawBySymbol.get(symbol) ?? [])])])));
    return Object.freeze({
      schemaVersion: "us-alpaca-historical-bars-v1", status, reason,
      provider: "ALPACA", market: "US_STOCK", venue: "US_SIP", feed: "sip",
      endpoint: ENDPOINT, timeframe, adjustment: "raw", asof: "-", currency: "USD",
      symbols: Object.freeze([...selected]), requestedInterval, observedAtMs,
      actualInterval: firstBarStartTimeMs === null ? null : Object.freeze({
        firstBarStartTimeMs, lastBarStartTimeMs, lastBarEndTimeMs,
      }),
      count: status === "BLOCKED_DATA" ? null : retainedBarCount,
      retainedBarCount, rawRowCount, duplicateRowCount, barsBySymbol, rawRowsBySymbol,
      rawPages: Object.freeze([...rawPages]), pageCount, paginationComplete,
      maxPages, pageRowLimit: MAX_PAGE_ROWS, providerReadOnlyGETs, httpStatus: null,
      missingRequestedSymbols: Object.freeze(selected.filter(symbol =>
        canonicalBySymbol.get(symbol)?.size === 0)),
      ...extra, ...proofLimits,
    });
  };
  const blocked = (reason, extra) => report("BLOCKED_DATA", reason, extra);
  const cohortValid = Array.isArray(symbols) && symbols.length >= 1 && symbols.length <= 20
    && symbols.every(symbol => typeof symbol === "string" && SYMBOL.test(symbol))
    && new Set(symbols).size === symbols.length;
  if (cohortValid) {
    selected = [...symbols];
    for (const symbol of selected) {
      canonicalBySymbol.set(symbol, new Map());
      rawBySymbol.set(symbol, []);
    }
  }
  const start = strictTime(startTime), end = strictTime(endTime);
  const inclusiveUtcCalendarDays = start !== null && end !== null && start < end
    ? Math.floor(end / DAY) - Math.floor(start / DAY) + 1 : null;
  if (inclusiveUtcCalendarDays !== null) {
    requestedInterval = Object.freeze({
      startTimeMs: start, endTimeMs: end, startInclusive: true, endInclusive: true,
      startTime: new Date(start).toISOString(), endTime: new Date(end).toISOString(),
      inclusiveUtcCalendarDays,
    });
  }
  if (typeof allowHistoricalDataRead !== "boolean") {
    throw new TypeError("ALPACA_HISTORICAL_READ_FLAG_INVALID");
  }
  if (!allowHistoricalDataRead) return blocked("EXPLICIT_HISTORICAL_DATA_READ_OPT_IN_REQUIRED");
  if (!credential(apiKey) || !credential(apiSecret)) {
    return blocked("ALPACA_DEDICATED_DATA_CREDENTIALS_REQUIRED");
  }
  if (!cohortValid
    || !["1Min", "1Day"].includes(timeframe)
    || !Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 32
    || typeof fetchImpl !== "function" || typeof nowImpl !== "function") {
    throw new TypeError("ALPACA_HISTORICAL_ARGUMENT_INVALID");
  }
  if (start === null || end === null || start >= end) {
    throw new TypeError("ALPACA_HISTORICAL_INTERVAL_INVALID");
  }
  if (inclusiveUtcCalendarDays > 31) return blocked("ALPACA_TASK_EXCEEDS_31_UTC_CALENDAR_DAYS");
  observedAtMs = nowImpl();
  if (!safeIntegerTime(observedAtMs)) throw new TypeError("ALPACA_CAPTURE_CLOCK_INVALID");
  if (end > observedAtMs - LAG) return blocked("ALPACA_FREE_SIP_END_NOT_15_MINUTES_OLD");

  const seenTokens = new Set();
  let pageToken = null;
  for (let index = 0; index < maxPages; index++) {
    const url = new URL(ENDPOINT);
    for (const [key, value] of Object.entries({
      symbols: selected.join(","), timeframe, start: requestedInterval.startTime,
      end: requestedInterval.endTime, feed: "sip", adjustment: "raw", asof: "-",
      sort: "asc", currency: "USD", limit: String(MAX_PAGE_ROWS),
    })) url.searchParams.set(key, value);
    if (pageToken !== null) url.searchParams.set("page_token", pageToken);
    const deadline = performance.now() + PAGE_TIMEOUT_MS;
    const signal = AbortSignal.timeout(PAGE_TIMEOUT_MS);
    let response;
    try {
      providerReadOnlyGETs++;
      response = await fetchImpl(url, {
        method: "GET", redirect: "error", credentials: "omit",
        headers: { accept: "application/json", "APCA-API-KEY-ID": apiKey,
          "APCA-API-SECRET-KEY": apiSecret },
        signal,
      });
    } catch (error) {
      const reason = transportReason(error);
      if (!reason) throw error;
      return blocked(reason);
    }
    if (!object(response) || !Number.isSafeInteger(response.status)
      || response.status < 100 || response.status > 599) {
      return blocked("ALPACA_RESPONSE_ENVELOPE_INVALID");
    }
    if (response.redirected === true) return blocked("ALPACA_REDIRECT_REJECTED");
    if (typeof response.url === "string" && response.url.length > 0) {
      let responseUrl;
      try {
        responseUrl = new URL(response.url);
      } catch (error) {
        if (!(error instanceof TypeError)) throw error;
        return blocked("ALPACA_RESPONSE_URL_INVALID");
      }
      if (responseUrl.origin !== "https://data.alpaca.markets"
        || responseUrl.pathname !== "/v2/stocks/bars"
        || responseUrl.username || responseUrl.password || responseUrl.hash) {
        return blocked("ALPACA_RESPONSE_URL_INVALID");
      }
    }
    if (response.status !== 200) {
      // Do not parse or return an error body, echoed credentials, status text,
      // headers or provider message. The fixed local reason is sufficient.
      return blocked(httpReason(response.status), { httpStatus: response.status });
    }
    let rawBytes;
    try {
      rawBytes = await readBoundedResponseBytes(response, signal, deadline);
    } catch (error) {
      const reason = error instanceof AlpacaBodyReadFailure ? error.reason : transportReason(error);
      if (!reason) throw error;
      return blocked(reason);
    }
    pageCount++;
    rawPages.push(Object.freeze({
      pageNumber: pageCount, rawPageSha256: hash(rawBytes), rawPageByteLength: rawBytes.byteLength,
      requestPageTokenSha256: pageToken === null ? null : hash(pageToken),
    }));
    let rawText;
    try {
      rawText = new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return blocked("ALPACA_RESPONSE_ENCODING_INVALID");
    }
    let payload;
    try {
      payload = JSON.parse(rawText);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return blocked("ALPACA_RESPONSE_JSON_INVALID");
    }
    if (!object(payload) || !object(payload.bars)
      || Object.hasOwn(payload, "code") || Object.hasOwn(payload, "message")) {
      return blocked("ALPACA_RESPONSE_BARS_INVALID");
    }
    const names = Object.keys(payload.bars);
    if (names.some(symbol => !canonicalBySymbol.has(symbol))) {
      return blocked("ALPACA_UNREQUESTED_SYMBOL_RETURNED");
    }
    if (names.some(symbol => !Array.isArray(payload.bars[symbol]))) {
      return blocked("ALPACA_RESPONSE_BARS_INVALID");
    }
    const pageRows = names.reduce((sum, symbol) => sum + payload.bars[symbol].length, 0);
    if (pageRows > MAX_PAGE_ROWS) return blocked("ALPACA_PAGE_ROW_LIMIT_EXCEEDED");
    const staged = new Map(selected.map(symbol => [symbol, new Map()]));
    const stagedRaw = new Map(selected.map(symbol => [symbol, []]));
    let stagedDuplicateCount = 0;
    for (const symbol of names) {
      const prior = canonicalBySymbol.get(symbol), current = staged.get(symbol);
      let lastTimestamp = prior.size ? [...prior.keys()].at(-1) : null;
      for (const raw of payload.bars[symbol]) {
        const normalized = normalizeBar(raw, symbol, timeframe, start, end, observedAtMs);
        if (normalized.reason) return blocked(normalized.reason);
        const row = normalized.canonical, existing = current.get(row.timestamp) ?? prior.get(row.timestamp);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(row)) {
            return blocked("ALPACA_DUPLICATE_BAR_CONFLICT");
          }
          stagedDuplicateCount++;
        } else {
          if (lastTimestamp !== null && row.timestamp < lastTimestamp) {
            return blocked("ALPACA_BAR_ORDER_INVALID");
          }
          current.set(row.timestamp, row);
          lastTimestamp = row.timestamp;
        }
        stagedRaw.get(symbol).push(normalized.raw);
      }
    }
    for (const symbol of selected) {
      for (const [timestamp, row] of staged.get(symbol)) {
        canonicalBySymbol.get(symbol).set(timestamp, row);
        retainedBarCount++;
        firstBarStartTimeMs = firstBarStartTimeMs === null ? timestamp
          : Math.min(firstBarStartTimeMs, timestamp);
        lastBarStartTimeMs = lastBarStartTimeMs === null ? timestamp
          : Math.max(lastBarStartTimeMs, timestamp);
        lastBarEndTimeMs = lastBarEndTimeMs === null ? row.barEndTimeMs
          : Math.max(lastBarEndTimeMs, row.barEndTimeMs);
      }
      rawBySymbol.get(symbol).push(...stagedRaw.get(symbol));
    }
    rawRowCount += pageRows;
    duplicateRowCount += stagedDuplicateCount;
    if (!Object.hasOwn(payload, "next_page_token")) {
      return blocked("ALPACA_PAGINATION_TOKEN_MISSING");
    }
    const next = payload.next_page_token;
    if (next === null) {
      paginationComplete = true;
      if (retainedBarCount === 0) return blocked("ALPACA_NO_BARS_RETURNED");
      if (selected.some(symbol => canonicalBySymbol.get(symbol).size === 0)) {
        return blocked("ALPACA_REQUESTED_SYMBOL_DATA_MISSING");
      }
      return report("SOURCE_LIMITED_HISTORICAL_BARS_COLLECTED_ONLY",
        "HISTORICAL_UNIVERSE_AND_COVERAGE_NOT_PROVEN");
    }
    if (typeof next !== "string" || next.length < 1 || next.length > 2048
      || !/^[\x21-\x7e]+$/u.test(next) || next.includes(apiKey) || next.includes(apiSecret)) {
      return blocked("ALPACA_PAGINATION_TOKEN_INVALID");
    }
    if (seenTokens.has(next)) return blocked("ALPACA_PAGINATION_TOKEN_LOOP");
    seenTokens.add(next);
    pageToken = next;
  }
  return blocked("ALPACA_MAX_PAGES_REACHED");
}
