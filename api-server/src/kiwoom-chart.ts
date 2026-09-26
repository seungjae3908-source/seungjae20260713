import {
  isKiwoomConfigured,
  kiwoomRequest,
  type KiwoomApiResponse,
} from "./providers/kiwoom";

export interface KiwoomChartCandle {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type KiwoomChartStopReason =
  | "TARGET_REACHED"
  | "SOURCE_EXHAUSTED"
  | "PAGE_BUDGET_REACHED"
  | "DEADLINE_REACHED"
  | "ABORTED"
  | "UPSTREAM_TIMEOUT";

export interface KiwoomChartFetchOptions {
  signal?: AbortSignal;
  deadlineAt?: number;
  maxPages?: number;
}

export interface KiwoomChartFetchResult {
  candles: KiwoomChartCandle[];
  completeness: "complete" | "partial";
  stopReason: KiwoomChartStopReason;
  pagesFetched: number;
  targetCandles: number | null;
}

type RawObject = Record<string, unknown>;

interface RequestSpec {
  apiId: string;
  path: string;
  body: Record<string, unknown>;
  maxPages: number;
  aggregateSize?: number;
}

interface RawFetchResult {
  rows: KiwoomChartCandle[];
  pagesFetched: number;
  stopReason: KiwoomChartStopReason;
}

const CHART_PATH = "/api/dostk/chart";
const CONTINUATION_DELAY_MS = 80;

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function deadlineReached(deadlineAt?: number): boolean {
  return deadlineAt != null && Number.isFinite(deadlineAt) && Date.now() >= deadlineAt;
}

function throwIfStopped(options: KiwoomChartFetchOptions): void {
  if (deadlineReached(options.deadlineAt)) {
    throw abortError("키움 차트 interactive deadline에 도달했습니다.");
  }

  if (options.signal?.aborted) {
    throw abortError("키움 차트 요청이 호출자에 의해 취소되었습니다.");
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortError("키움 차트 요청이 호출자에 의해 취소되었습니다."));
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortError("키움 차트 요청이 호출자에 의해 취소되었습니다."));
    };

    const timer = setTimeout(finish, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function normalizeTicker(value: string): string {
  return String(value ?? "")
    .trim()
    .toUpperCase();
}

function normalizeTimeframe(value: string): string {
  const raw = String(value ?? "1D").trim();

  return raw || "1D";
}

function koreaToday(): string {
  const now = new Date();

  const koreaTime = new Date(
    now.getTime() + 9 * 60 * 60 * 1000,
  );

  return koreaTime
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

function toFiniteNumber(value: unknown): number | null {
  if (
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  const normalized = value
    .replace(/,/g, "")
    .replace(/[+%₩$원]/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function absoluteFiniteNumber(
  value: unknown,
): number | null {
  const parsed = toFiniteNumber(value);

  return parsed == null
    ? null
    : Math.abs(parsed);
}

function pick(
  row: RawObject,
  keys: string[],
): unknown {
  for (const key of keys) {
    const value = row[key];

    if (
      value != null &&
      value !== ""
    ) {
      return value;
    }
  }

  return undefined;
}

function rowLooksLikeChart(
  row: RawObject,
): boolean {
  const date = pick(row, [
    "dt",
    "date",
    "cntr_tm",
    "time",
    "datetime",
    "timestamp",
    "xymd",
    "base_dt",
    "trde_dt",
  ]);

  const close = pick(row, [
    "cur_prc",
    "close",
    "close_pric",
    "closePrice",
    "last",
    "price",
  ]);

  const open = pick(row, [
    "open_pric",
    "open",
    "openPrice",
    "open_prc",
  ]);

  const high = pick(row, [
    "high_pric",
    "high",
    "highPrice",
    "high_prc",
  ]);

  const low = pick(row, [
    "low_pric",
    "low",
    "lowPrice",
    "low_prc",
  ]);

  return Boolean(
    date &&
      close != null &&
      open != null &&
      high != null &&
      low != null,
  );
}

function collectChartArrays(
  value: unknown,
  depth = 0,
  results: RawObject[][] = [],
): RawObject[][] {
  if (
    depth > 6 ||
    value == null
  ) {
    return results;
  }

  if (Array.isArray(value)) {
    const objectRows = value.filter(
      (
        item,
      ): item is RawObject =>
        Boolean(item) &&
        typeof item === "object" &&
        !Array.isArray(item),
    );

    if (
      objectRows.length > 0 &&
      objectRows.some(rowLooksLikeChart)
    ) {
      results.push(objectRows);
    }

    for (const item of value) {
      collectChartArrays(
        item,
        depth + 1,
        results,
      );
    }

    return results;
  }

  if (typeof value === "object") {
    for (
      const nested of Object.values(
        value as RawObject,
      )
    ) {
      collectChartArrays(
        nested,
        depth + 1,
        results,
      );
    }
  }

  return results;
}

function bestChartRows(
  data: RawObject,
): RawObject[] {
  const arrays = collectChartArrays(data);

  if (arrays.length === 0) {
    return [];
  }

  return arrays.sort((a, b) => {
    const scoreA =
      a.filter(rowLooksLikeChart).length *
        1_000 +
      a.length;

    const scoreB =
      b.filter(rowLooksLikeChart).length *
        1_000 +
      b.length;

    return scoreB - scoreA;
  })[0];
}

function combineDateAndTime(
  row: RawObject,
): string {
  const date = String(
    pick(row, [
      "dt",
      "date",
      "xymd",
      "trde_dt",
      "base_dt",
    ]) ?? "",
  )
    .replace(/\D/g, "")
    .trim();

  const time = String(
    pick(row, [
      "cntr_tm",
      "time",
      "hhmmss",
      "trde_tm",
    ]) ?? "",
  )
    .replace(/\D/g, "")
    .trim();

  if (time.length >= 12) {
    return time.slice(0, 14);
  }

  if (
    date.length === 8 &&
    time.length >= 4 &&
    time.length <= 6
  ) {
    return `${date}${time.padEnd(6, "0")}`;
  }

  if (date.length === 8) {
    return date;
  }

  if (time.length >= 8) {
    return time;
  }

  return String(
    pick(row, [
      "datetime",
      "timestamp",
      "cntr_tm",
      "time",
      "dt",
      "date",
    ]) ?? "",
  ).trim();
}

function normalizeRow(
  row: RawObject,
): KiwoomChartCandle | null {
  const close = absoluteFiniteNumber(
    pick(row, [
      "cur_prc",
      "close",
      "close_pric",
      "closePrice",
      "last",
      "price",
    ]),
  );

  const open = absoluteFiniteNumber(
    pick(row, [
      "open_pric",
      "open",
      "openPrice",
      "open_prc",
    ]),
  );

  const high = absoluteFiniteNumber(
    pick(row, [
      "high_pric",
      "high",
      "highPrice",
      "high_prc",
    ]),
  );

  const low = absoluteFiniteNumber(
    pick(row, [
      "low_pric",
      "low",
      "lowPrice",
      "low_prc",
    ]),
  );

  const volume = absoluteFiniteNumber(
    pick(row, [
      "trde_qty",
      "acc_trde_qty",
      "volume",
      "tradeVolume",
      "tradingVolume",
      "acml_vol",
    ]),
  );

  const time = combineDateAndTime(row);

  if (
    !time ||
    close == null ||
    open == null ||
    high == null ||
    low == null
  ) {
    return null;
  }

  return {
    time,

    open,

    high: Math.max(
      high,
      open,
      close,
    ),

    low: Math.min(
      low,
      open,
      close,
    ),

    close,

    volume: Math.max(
      volume ?? 0,
      0,
    ),
  };
}

function timeSortValue(
  value: string,
): number {
  const digits = String(value ?? "")
    .replace(/\D/g, "");

  const parsed = Number(digits);

  return Number.isFinite(parsed)
    ? parsed
    : 0;
}

function dedupeAndSort(
  rows: KiwoomChartCandle[],
): KiwoomChartCandle[] {
  const map = new Map<
    string,
    KiwoomChartCandle
  >();

  for (const row of rows) {
    map.set(row.time, row);
  }

  return [...map.values()].sort(
    (a, b) =>
      timeSortValue(a.time) -
      timeSortValue(b.time),
  );
}

function aggregateCandles(
  rows: KiwoomChartCandle[],
  size: number,
): KiwoomChartCandle[] {
  if (
    size <= 1 ||
    rows.length <= 1
  ) {
    return rows;
  }

  const result: KiwoomChartCandle[] = [];

  for (
    let index = 0;
    index < rows.length;
    index += size
  ) {
    const chunk = rows.slice(
      index,
      index + size,
    );

    if (chunk.length === 0) {
      continue;
    }

    result.push({
      time: chunk[0].time,

      open: chunk[0].open,

      high: Math.max(
        ...chunk.map(
          (item) => item.high,
        ),
      ),

      low: Math.min(
        ...chunk.map(
          (item) => item.low,
        ),
      ),

      close:
        chunk[chunk.length - 1].close,

      volume: chunk.reduce(
        (sum, item) =>
          sum + item.volume,
        0,
      ),
    });
  }

  return result;
}

function requestSpec(
  ticker: string,
  timeframe: string,
): RequestSpec {
  const tf =
    normalizeTimeframe(timeframe);

  const baseBody = {
    stk_cd: ticker,
    upd_stkpc_tp: "1",
  };

  const minuteScope: Record<
    string,
    string
  > = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "1H": "60",
    "60m": "60",
    "4H": "60",
  };

  if (minuteScope[tf]) {
    return {
      apiId: "ka10080",
      path: CHART_PATH,
      body: {
        ...baseBody,
        tic_scope: minuteScope[tf],
      },
      maxPages: 300,
      aggregateSize: tf === "4H" ? 4 : 1,
    };
  }

  if (tf === "1W") {
    return {
      apiId: "ka10082",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday(),
      },
      maxPages: 150,
    };
  }

  if (tf === "1M") {
    return {
      apiId: "ka10083",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday(),
      },
      maxPages: 100,
    };
  }

  if (tf === "1Y") {
    return {
      apiId: "ka10094",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday(),
      },
      maxPages: 60,
    };
  }

  const aggregateSize =
    tf === "3D"
      ? 3
      : tf === "5D"
        ? 5
        : tf === "10D"
          ? 10
          : 1;

  return {
    apiId: "ka10081",
    path: CHART_PATH,
    body: {
      ...baseBody,
      base_dt: koreaToday(),
    },
    maxPages: 300,
    aggregateSize,
  };
}

export function resolveKiwoomRawTargetCandles(
  targetCandles: number | undefined,
  aggregateSize = 1,
): number | undefined {
  if (
    targetCandles == null ||
    !Number.isFinite(targetCandles) ||
    targetCandles <= 0
  ) {
    return undefined;
  }

  const normalizedTarget = Math.max(2, Math.floor(targetCandles));
  const normalizedAggregate = Math.max(1, Math.floor(aggregateSize));

  return normalizedTarget * normalizedAggregate;
}

async function fetchAllPages(
  spec: RequestSpec,
  targetRawCandles?: number,
  options: KiwoomChartFetchOptions = {},
): Promise<RawFetchResult> {
  const collected: KiwoomChartCandle[] = [];
  const seenNextKeys = new Set<string>();
  const requestedMaxPages = Number.isFinite(options.maxPages)
    ? Math.max(1, Math.floor(Number(options.maxPages)))
    : spec.maxPages;
  const effectiveMaxPages = Math.min(spec.maxPages, requestedMaxPages);

  let contYn: string | undefined;
  let nextKey: string | undefined;
  let pagesFetched = 0;
  let stopReason: KiwoomChartStopReason | null = null;

  for (
    let page = 0;
    page < effectiveMaxPages;
    page += 1
  ) {
    try {
      throwIfStopped(options);
    } catch {
      stopReason = deadlineReached(options.deadlineAt)
        ? "DEADLINE_REACHED"
        : "ABORTED";
      break;
    }

    let response: {
      data: KiwoomApiResponse;
      contYn: string | null;
      nextKey: string | null;
    };

    try {
      response = await kiwoomRequest<KiwoomApiResponse>({
        apiId: spec.apiId,
        path: spec.path,
        body: spec.body,
        contYn,
        nextKey,
        signal: options.signal,
      });
    } catch (error) {
      if (deadlineReached(options.deadlineAt)) {
        stopReason = "DEADLINE_REACHED";
      } else if (options.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        stopReason = "ABORTED";
      } else if (error instanceof Error && /시간이 초과되었습니다/.test(error.message)) {
        stopReason = "UPSTREAM_TIMEOUT";
      } else {
        throw error;
      }

      if (collected.length < 2) {
        throw error;
      }

      break;
    }

    pagesFetched += 1;

    const rows = bestChartRows(
      response.data as RawObject,
    );

    const normalizedRows = rows
      .map(normalizeRow)
      .filter(
        (
          item,
        ): item is KiwoomChartCandle =>
          item != null,
      );

    collected.push(
      ...normalizedRows,
    );

    if (
      targetRawCandles != null &&
      collected.length >= targetRawCandles
    ) {
      stopReason = "TARGET_REACHED";
      break;
    }

    const hasNext =
      String(
        response.contYn ?? "",
      ).toUpperCase() === "Y";

    const returnedNextKey =
      String(
        response.nextKey ?? "",
      ).trim();

    if (
      !hasNext ||
      !returnedNextKey
    ) {
      stopReason = "SOURCE_EXHAUSTED";
      break;
    }

    if (
      seenNextKeys.has(
        returnedNextKey,
      )
    ) {
      stopReason = "SOURCE_EXHAUSTED";
      break;
    }

    seenNextKeys.add(
      returnedNextKey,
    );

    contYn =
      response.contYn ?? "Y";

    nextKey =
      returnedNextKey;

    try {
      if (deadlineReached(options.deadlineAt)) {
        stopReason = "DEADLINE_REACHED";
        break;
      }

      await sleep(
        CONTINUATION_DELAY_MS,
        options.signal,
      );
    } catch {
      stopReason = deadlineReached(options.deadlineAt)
        ? "DEADLINE_REACHED"
        : "ABORTED";
      break;
    }
  }

  if (!stopReason) {
    stopReason = "PAGE_BUDGET_REACHED";
  }

  const sorted = dedupeAndSort(
    collected,
  );

  return {
    rows: targetRawCandles == null
      ? sorted
      : sorted.slice(-targetRawCandles),
    pagesFetched,
    stopReason,
  };
}

export async function getKiwoomChartCandlesMeta(
  tickerValue: string,
  timeframeValue = "1D",
  targetCandles?: number,
  options: KiwoomChartFetchOptions = {},
): Promise<KiwoomChartFetchResult> {
  if (!isKiwoomConfigured()) {
    throw new Error(
      "키움 API 키가 등록되지 않았습니다.",
    );
  }

  const ticker =
    normalizeTicker(tickerValue);

  if (
    !/^[0-9A-Z]{6}(?:_(?:NX|AL))?$/.test(
      ticker,
    )
  ) {
    throw new Error(
      `잘못된 국내 종목코드입니다: ${ticker}`,
    );
  }

  const timeframe =
    normalizeTimeframe(
      timeframeValue,
    );

  const spec = requestSpec(
    ticker,
    timeframe,
  );

  const rawTarget = resolveKiwoomRawTargetCandles(
    targetCandles,
    spec.aggregateSize ?? 1,
  );

  const rawResult =
    await fetchAllPages(spec, rawTarget, options);

  const aggregated =
    aggregateCandles(
      rawResult.rows,
      spec.aggregateSize ?? 1,
    );

  if (
    aggregated.length < 2
  ) {
    throw new Error(
      `키움 차트 데이터가 부족합니다. ticker=${ticker}, timeframe=${timeframe}, count=${aggregated.length}, stopReason=${rawResult.stopReason}`,
    );
  }

  const normalizedTarget =
    targetCandles != null &&
    Number.isFinite(targetCandles) &&
    targetCandles > 0
      ? Math.max(2, Math.floor(targetCandles))
      : null;

  const candles = normalizedTarget == null
    ? aggregated
    : aggregated.slice(-normalizedTarget);

  const targetSatisfied = normalizedTarget == null
    ? rawResult.stopReason === "SOURCE_EXHAUSTED"
    : candles.length >= normalizedTarget;

  return {
    candles,
    completeness: targetSatisfied ? "complete" : "partial",
    stopReason: targetSatisfied && normalizedTarget != null
      ? "TARGET_REACHED"
      : rawResult.stopReason,
    pagesFetched: rawResult.pagesFetched,
    targetCandles: normalizedTarget,
  };
}

export async function getKiwoomChartCandles(
  tickerValue: string,
  timeframeValue = "1D",
  targetCandles?: number,
  options: KiwoomChartFetchOptions = {},
): Promise<KiwoomChartCandle[]> {
  const result = await getKiwoomChartCandlesMeta(
    tickerValue,
    timeframeValue,
    targetCandles,
    options,
  );

  return result.candles;
}

export default getKiwoomChartCandles;
