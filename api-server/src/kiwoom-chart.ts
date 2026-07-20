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

type RawObject = Record<string, unknown>;

interface RequestSpec {
  apiId: string;
  path: string;
  body: Record<string, unknown>;
  maxPages: number;
  aggregateSize?: number;
  aggregateByDay?: boolean;
}

const CHART_PATH = "/api/dostk/chart";
const CONTINUATION_DELAY_MS = 80;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

  /*
   * 분봉의 cntr_tm이 YYYYMMDDHHMMSS 형태로
   * 반환되는 경우입니다.
   */
  if (time.length >= 12) {
    return time.slice(0, 14);
  }

  /*
   * 날짜와 시간이 따로 반환되는 경우입니다.
   */
  if (
    date.length === 8 &&
    time.length >= 4 &&
    time.length <= 6
  ) {
    return `${date}${time.padEnd(6, "0")}`;
  }

  /*
   * 일봉·월봉·연봉은 날짜만 사용합니다.
   */
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
  byDay = false,
): KiwoomChartCandle[] {
  const sortedRows = dedupeAndSort(rows);

  if (
    size <= 1 ||
    sortedRows.length <= 1
  ) {
    return sortedRows;
  }

  const result: KiwoomChartCandle[] = [];

  const groups = byDay
    ? [...sortedRows.reduce((map, row) => {
        const day = String(row.time ?? "")
          .replace(/\D/g, "")
          .slice(0, 8);
        const group = map.get(day) ?? [];
        group.push(row);
        map.set(day, group);
        return map;
      }, new Map<string, KiwoomChartCandle[]>()).values()]
    : [sortedRows];

  for (const group of groups) {
    for (
      let index = 0;
      index < group.length;
      index += size
    ) {
      const chunk = group.slice(
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

    /*
     * 수정주가 적용 여부입니다.
     * 1을 사용해 액면분할·병합 등이 반영된
     * 과거 가격을 받습니다.
     */
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
    "60m": "60",
    "1H": "60",
    "4H": "60",
  };

  if (minuteScope[tf]) {
    return {
      apiId: "ka10080",

      path: CHART_PATH,

      body: {
        ...baseBody,

        tic_scope:
          minuteScope[tf],
      },

      /*
       * 키움 연속조회가 허용하는 범위까지 동일하게 따라갑니다.
       * 중복 next-key 감지와 API의 cont-yn 종료 신호가 무한 호출을 막습니다.
       */
      maxPages: 300,

      /*
       * 키움에서 4시간봉을 직접 제공하지 않으면
       * 60분봉 4개를 합쳐 4시간봉으로 만듭니다.
       */
      aggregateSize:
        tf === "4H"
          ? 4
          : 1,

      aggregateByDay:
        tf === "4H",
    };
  }

  if (tf === "1W") {
    /*
     * 주봉은 키움 주봉 차트 API(ka10082)를 사용합니다.
     * 일봉(ka10081)과 별도의 데이터입니다.
     */
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
        : tf === "20D"
          ? 20
        : tf === "10D"
          ? 10
          : 1;

  /*
   * 1D와 ALL은 모두 일봉 전체를 조회합니다.
   * 3D·5D·10D·20D는 전체 일봉을 받은 뒤 묶습니다.
   */
  return {
    apiId: "ka10081",

    path: CHART_PATH,

    body: {
      ...baseBody,

      base_dt: koreaToday(),
    },

    /*
     * 상장일부터 현재까지 조회하기 위해
     * cont-yn과 next-key로 최대 300페이지를
     * 연속 조회합니다.
     */
    maxPages: 300,

    aggregateSize,
  };
}

async function fetchAllPages(
  spec: RequestSpec,
): Promise<KiwoomChartCandle[]> {
  const collected:
    KiwoomChartCandle[] = [];

  const seenNextKeys =
    new Set<string>();

  let contYn:
    string | undefined;

  let nextKey:
    string | undefined;

  for (
    let page = 0;
    page < spec.maxPages;
    page += 1
  ) {
    const response =
      await kiwoomRequest<KiwoomApiResponse>({
        apiId: spec.apiId,

        path: spec.path,

        body: spec.body,

        contYn,

        nextKey,
      });

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
      break;
    }

    /*
     * 같은 next-key가 반복되면 무한 반복을 막습니다.
     */
    if (
      seenNextKeys.has(
        returnedNextKey,
      )
    ) {
      break;
    }

    seenNextKeys.add(
      returnedNextKey,
    );

    contYn =
      response.contYn ?? "Y";

    nextKey =
      returnedNextKey;

    /*
     * 연속 호출 사이에 짧은 간격을 둡니다.
     */
    await sleep(
      CONTINUATION_DELAY_MS,
    );
  }

  return dedupeAndSort(
    collected,
  );
}

export async function getKiwoomChartCandles(
  tickerValue: string,
  timeframeValue = "1D",
): Promise<KiwoomChartCandle[]> {
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

  const rows =
    await fetchAllPages(spec);

  const aggregated =
    aggregateCandles(
      rows,
      spec.aggregateSize ?? 1,
      spec.aggregateByDay ?? false,
    );

  if (
    aggregated.length < 2
  ) {
    throw new Error(
      `키움 차트 데이터가 부족합니다. ticker=${ticker}, timeframe=${timeframe}, count=${aggregated.length}`,
    );
  }

  return aggregated;
}

export default getKiwoomChartCandles;
