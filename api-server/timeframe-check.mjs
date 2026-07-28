// src/providers/kiwoom.ts
var REAL_BASE_URL = process.env.KIWOOM_BASE_URL?.trim() || "http://158.247.235.32:3000/kiwoom";
var MOCK_BASE_URL = "https://mockapi.kiwoom.com";
var REQUEST_TIMEOUT_MS = 15e3;
var tokenCache = null;
var requestQueue = Promise.resolve();
var nextRequestAt = 0;
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function waitForRequestSlot() {
  const previous = requestQueue;
  let release = () => void 0;
  requestQueue = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  const minimumInterval = isMockMode() ? 260 : 240;
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait > 0) await sleep(wait);
  nextRequestAt = Date.now() + minimumInterval;
  release();
}
function isMockMode() {
  return process.env.KIWOOM_MODE?.trim().toLowerCase() === "mock";
}
function baseUrl() {
  return isMockMode() ? MOCK_BASE_URL : REAL_BASE_URL;
}
function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `${name} \uD658\uACBD\uBCC0\uC218\uAC00 \uB4F1\uB85D\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.`
    );
  }
  return value;
}
function proxyHeaders() {
  if (isMockMode()) {
    return {};
  }
  return {
    "x-proxy-key": requireEnv(
      "KIWOOM_PROXY_KEY"
    )
  };
}
async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(
      text
    );
  } catch {
    throw new Error(
      `\uD0A4\uC6C0 API\uAC00 JSON\uC774 \uC544\uB2CC \uC751\uB2F5\uC744 \uBC18\uD658\uD588\uC2B5\uB2C8\uB2E4. HTTP ${response.status}: ${text.slice(0, 240)}`
    );
  }
}
function returnCode(data) {
  const raw = data.return_code;
  if (raw == null || raw === "") {
    return 0;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : -1;
}
function returnMessage(data) {
  return typeof data.return_msg === "string" && data.return_msg.trim() ? data.return_msg : "\uC54C \uC218 \uC5C6\uB294 \uD0A4\uC6C0 API \uC624\uB958";
}
function clearKiwoomTokenCache() {
  tokenCache = null;
}
function isKiwoomConfigured() {
  return Boolean(
    process.env.KIWOOM_APP_KEY?.trim() && process.env.KIWOOM_APP_SECRET?.trim() && (isMockMode() || process.env.KIWOOM_PROXY_KEY?.trim())
  );
}
async function getKiwoomToken() {
  if (tokenCache && Date.now() < tokenCache.expiresAt - 5 * 60 * 1e3) {
    return tokenCache.token;
  }
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  try {
    const response = await fetch(
      `${baseUrl()}/oauth2/token`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json;charset=UTF-8",
          ...proxyHeaders()
        },
        body: JSON.stringify({
          grant_type: "client_credentials",
          appkey: requireEnv(
            "KIWOOM_APP_KEY"
          ),
          secretkey: requireEnv(
            "KIWOOM_APP_SECRET"
          )
        }),
        signal: controller.signal
      }
    );
    const result = await readJson(
      response
    );
    if (!response.ok || returnCode(result) !== 0 || !result.token) {
      throw new Error(
        `\uD0A4\uC6C0 \uD1A0\uD070 \uBC1C\uAE09 \uC2E4\uD328: ${returnMessage(result)} (HTTP ${response.status})`
      );
    }
    tokenCache = {
      token: result.token,
      expiresAt: Date.now() + 23 * 60 * 60 * 1e3
    };
    return result.token;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        "\uD0A4\uC6C0 \uD1A0\uD070 \uC694\uCCAD \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4."
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
async function kiwoomRequest({
  apiId,
  path,
  body,
  contYn,
  nextKey,
  retryAuth = true,
  retryRateLimit = 0
}) {
  const token = await getKiwoomToken();
  await waitForRequestSlot();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS
  );
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json;charset=UTF-8",
    authorization: `Bearer ${token}`,
    "api-id": apiId,
    ...proxyHeaders()
  };
  if (contYn) {
    headers["cont-yn"] = contYn;
  }
  if (nextKey) {
    headers["next-key"] = nextKey;
  }
  try {
    const response = await fetch(
      `${baseUrl()}${path}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const result = await readJson(response);
    if (!response.ok || returnCode(result) !== 0) {
      const message = returnMessage(result);
      const rateLimited = response.status === 429 || returnCode(result) === 1700 || /요청 개수|too many|rate limit/i.test(message);
      if (rateLimited && retryRateLimit < 4) {
        clearTimeout(timeout);
        await sleep(700 * Math.pow(2, retryRateLimit));
        return kiwoomRequest({
          apiId,
          path,
          body,
          contYn,
          nextKey,
          retryAuth,
          retryRateLimit: retryRateLimit + 1
        });
      }
      const authExpired = response.status === 401 || response.status === 403 || returnCode(result) === 8005 || message.toLowerCase().includes("token");
      if (authExpired) {
        clearKiwoomTokenCache();
        if (retryAuth) {
          return kiwoomRequest({ apiId, path, body, contYn, nextKey, retryAuth: false, retryRateLimit });
        }
      }
      throw new Error(
        `\uD0A4\uC6C0 ${apiId} \uC694\uCCAD \uC2E4\uD328: ${message} (HTTP ${response.status})`
      );
    }
    return {
      data: result,
      contYn: response.headers.get(
        "cont-yn"
      ),
      nextKey: response.headers.get(
        "next-key"
      )
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `\uD0A4\uC6C0 ${apiId} \uC694\uCCAD \uC2DC\uAC04\uC774 \uCD08\uACFC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.`
      );
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// src/kiwoom-chart.ts
var CHART_PATH = "/api/dostk/chart";
var CONTINUATION_DELAY_MS = 80;
function sleep2(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function normalizeTicker(value) {
  return String(value ?? "").trim().toUpperCase();
}
function normalizeTimeframe(value) {
  const raw = String(value ?? "1D").trim();
  return raw || "1D";
}
function koreaToday() {
  const now = /* @__PURE__ */ new Date();
  const koreaTime = new Date(
    now.getTime() + 9 * 60 * 60 * 1e3
  );
  return koreaTime.toISOString().slice(0, 10).replace(/-/g, "");
}
function toFiniteNumber(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/,/g, "").replace(/[+%₩$원]/g, "").trim();
  if (!normalized) {
    return null;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}
function absoluteFiniteNumber(value) {
  const parsed = toFiniteNumber(value);
  return parsed == null ? null : Math.abs(parsed);
}
function pick(row, keys) {
  for (const key of keys) {
    const value = row[key];
    if (value != null && value !== "") {
      return value;
    }
  }
  return void 0;
}
function rowLooksLikeChart(row) {
  const date = pick(row, [
    "dt",
    "date",
    "cntr_tm",
    "time",
    "datetime",
    "timestamp",
    "xymd",
    "base_dt",
    "trde_dt"
  ]);
  const close = pick(row, [
    "cur_prc",
    "close",
    "close_pric",
    "closePrice",
    "last",
    "price"
  ]);
  const open = pick(row, [
    "open_pric",
    "open",
    "openPrice",
    "open_prc"
  ]);
  const high = pick(row, [
    "high_pric",
    "high",
    "highPrice",
    "high_prc"
  ]);
  const low = pick(row, [
    "low_pric",
    "low",
    "lowPrice",
    "low_prc"
  ]);
  return Boolean(
    date && close != null && open != null && high != null && low != null
  );
}
function collectChartArrays(value, depth = 0, results = []) {
  if (depth > 6 || value == null) {
    return results;
  }
  if (Array.isArray(value)) {
    const objectRows = value.filter(
      (item) => Boolean(item) && typeof item === "object" && !Array.isArray(item)
    );
    if (objectRows.length > 0 && objectRows.some(rowLooksLikeChart)) {
      results.push(objectRows);
    }
    for (const item of value) {
      collectChartArrays(
        item,
        depth + 1,
        results
      );
    }
    return results;
  }
  if (typeof value === "object") {
    for (const nested of Object.values(
      value
    )) {
      collectChartArrays(
        nested,
        depth + 1,
        results
      );
    }
  }
  return results;
}
function bestChartRows(data) {
  const arrays = collectChartArrays(data);
  if (arrays.length === 0) {
    return [];
  }
  return arrays.sort((a, b) => {
    const scoreA = a.filter(rowLooksLikeChart).length * 1e3 + a.length;
    const scoreB = b.filter(rowLooksLikeChart).length * 1e3 + b.length;
    return scoreB - scoreA;
  })[0];
}
function combineDateAndTime(row) {
  const date = String(
    pick(row, [
      "dt",
      "date",
      "xymd",
      "trde_dt",
      "base_dt"
    ]) ?? ""
  ).replace(/\D/g, "").trim();
  const time = String(
    pick(row, [
      "cntr_tm",
      "time",
      "hhmmss",
      "trde_tm"
    ]) ?? ""
  ).replace(/\D/g, "").trim();
  if (time.length >= 12) {
    return time.slice(0, 14);
  }
  if (date.length === 8 && time.length >= 4 && time.length <= 6) {
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
      "date"
    ]) ?? ""
  ).trim();
}
function normalizeRow(row) {
  const close = absoluteFiniteNumber(
    pick(row, [
      "cur_prc",
      "close",
      "close_pric",
      "closePrice",
      "last",
      "price"
    ])
  );
  const open = absoluteFiniteNumber(
    pick(row, [
      "open_pric",
      "open",
      "openPrice",
      "open_prc"
    ])
  );
  const high = absoluteFiniteNumber(
    pick(row, [
      "high_pric",
      "high",
      "highPrice",
      "high_prc"
    ])
  );
  const low = absoluteFiniteNumber(
    pick(row, [
      "low_pric",
      "low",
      "lowPrice",
      "low_prc"
    ])
  );
  const volume = absoluteFiniteNumber(
    pick(row, [
      "trde_qty",
      "acc_trde_qty",
      "volume",
      "tradeVolume",
      "tradingVolume",
      "acml_vol"
    ])
  );
  const time = combineDateAndTime(row);
  if (!time || close == null || open == null || high == null || low == null) {
    return null;
  }
  return {
    time,
    open,
    high: Math.max(
      high,
      open,
      close
    ),
    low: Math.min(
      low,
      open,
      close
    ),
    close,
    volume: Math.max(
      volume ?? 0,
      0
    )
  };
}
function timeSortValue(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  const parsed = Number(digits);
  return Number.isFinite(parsed) ? parsed : 0;
}
function dedupeAndSort(rows) {
  const map = /* @__PURE__ */ new Map();
  for (const row of rows) {
    map.set(row.time, row);
  }
  return [...map.values()].sort(
    (a, b) => timeSortValue(a.time) - timeSortValue(b.time)
  );
}
function aggregateCandles(rows, size, byDay = false) {
  const sortedRows = dedupeAndSort(rows);
  if (size <= 1 || sortedRows.length <= 1) {
    return sortedRows;
  }
  const result = [];
  const groups = byDay ? [...sortedRows.reduce((map, row) => {
    const day = String(row.time ?? "").replace(/\D/g, "").slice(0, 8);
    const group = map.get(day) ?? [];
    group.push(row);
    map.set(day, group);
    return map;
  }, /* @__PURE__ */ new Map()).values()] : [sortedRows];
  for (const group of groups) {
    for (let index = 0; index < group.length; index += size) {
      const chunk = group.slice(
        index,
        index + size
      );
      if (chunk.length === 0) {
        continue;
      }
      result.push({
        time: chunk[0].time,
        open: chunk[0].open,
        high: Math.max(
          ...chunk.map(
            (item) => item.high
          )
        ),
        low: Math.min(
          ...chunk.map(
            (item) => item.low
          )
        ),
        close: chunk[chunk.length - 1].close,
        volume: chunk.reduce(
          (sum, item) => sum + item.volume,
          0
        )
      });
    }
  }
  return result;
}
function requestSpec(ticker, timeframe) {
  const tf = normalizeTimeframe(timeframe);
  const baseBody = {
    stk_cd: ticker,
    /*
     * 수정주가 적용 여부입니다.
     * 1을 사용해 액면분할·병합 등이 반영된
     * 과거 가격을 받습니다.
     */
    upd_stkpc_tp: "1"
  };
  const minuteScope = {
    "1m": "1",
    "3m": "3",
    "5m": "5",
    "15m": "15",
    "30m": "30",
    "60m": "60",
    "1H": "60",
    "4H": "60",
    "8H": "60",
    "12H": "60"
  };
  if (minuteScope[tf]) {
    return {
      apiId: "ka10080",
      path: CHART_PATH,
      body: {
        ...baseBody,
        tic_scope: minuteScope[tf]
      },
      /*
       * 키움 연속조회가 허용하는 범위까지 동일하게 따라갑니다.
       * 중복 next-key 감지와 API의 cont-yn 종료 신호가 무한 호출을 막습니다.
       */
      maxPages: 300,
      /*
       * 키움에서 장시간 봉을 직접 제공하지 않으므로
       * 60분봉을 요청한 시간 수만큼 합칩니다.
       */
      aggregateSize: tf === "4H" ? 4 : tf === "8H" ? 8 : tf === "12H" ? 12 : 1,
      aggregateByDay: tf === "4H" || tf === "8H" || tf === "12H"
    };
  }
  if (tf === "1W") {
    return {
      apiId: "ka10082",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday()
      },
      maxPages: 150
    };
  }
  if (tf === "1M" || tf === "3M" || tf === "6M") {
    return {
      apiId: "ka10083",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday()
      },
      maxPages: 100,
      aggregateSize: tf === "3M" ? 3 : tf === "6M" ? 6 : 1
    };
  }
  if (tf === "1Y") {
    return {
      apiId: "ka10094",
      path: CHART_PATH,
      body: {
        ...baseBody,
        base_dt: koreaToday()
      },
      maxPages: 60
    };
  }
  const aggregateSize = tf === "3D" ? 3 : tf === "5D" ? 5 : tf === "15D" ? 15 : tf === "20D" ? 20 : tf === "10D" ? 10 : 1;
  return {
    apiId: "ka10081",
    path: CHART_PATH,
    body: {
      ...baseBody,
      base_dt: koreaToday()
    },
    /*
     * 상장일부터 현재까지 조회하기 위해
     * cont-yn과 next-key로 최대 300페이지를
     * 연속 조회합니다.
     */
    maxPages: 300,
    aggregateSize
  };
}
async function fetchAllPages(spec) {
  const collected = [];
  const seenNextKeys = /* @__PURE__ */ new Set();
  let contYn;
  let nextKey;
  for (let page = 0; page < spec.maxPages; page += 1) {
    const response = await kiwoomRequest({
      apiId: spec.apiId,
      path: spec.path,
      body: spec.body,
      contYn,
      nextKey
    });
    const rows = bestChartRows(
      response.data
    );
    const normalizedRows = rows.map(normalizeRow).filter(
      (item) => item != null
    );
    collected.push(
      ...normalizedRows
    );
    const hasNext = String(
      response.contYn ?? ""
    ).toUpperCase() === "Y";
    const returnedNextKey = String(
      response.nextKey ?? ""
    ).trim();
    if (!hasNext || !returnedNextKey) {
      break;
    }
    if (seenNextKeys.has(
      returnedNextKey
    )) {
      break;
    }
    seenNextKeys.add(
      returnedNextKey
    );
    contYn = response.contYn ?? "Y";
    nextKey = returnedNextKey;
    await sleep2(
      CONTINUATION_DELAY_MS
    );
  }
  return dedupeAndSort(
    collected
  );
}
async function getKiwoomChartCandles(tickerValue, timeframeValue = "1D") {
  if (!isKiwoomConfigured()) {
    throw new Error(
      "\uD0A4\uC6C0 API \uD0A4\uAC00 \uB4F1\uB85D\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."
    );
  }
  const ticker = normalizeTicker(tickerValue);
  if (!/^[0-9A-Z]{6}(?:_(?:NX|AL))?$/.test(
    ticker
  )) {
    throw new Error(
      `\uC798\uBABB\uB41C \uAD6D\uB0B4 \uC885\uBAA9\uCF54\uB4DC\uC785\uB2C8\uB2E4: ${ticker}`
    );
  }
  const timeframe = normalizeTimeframe(
    timeframeValue
  );
  const spec = requestSpec(
    ticker,
    timeframe
  );
  const rows = await fetchAllPages(spec);
  const aggregated = aggregateCandles(
    rows,
    spec.aggregateSize ?? 1,
    spec.aggregateByDay ?? false
  );
  if (aggregated.length < 2) {
    throw new Error(
      `\uD0A4\uC6C0 \uCC28\uD2B8 \uB370\uC774\uD130\uAC00 \uBD80\uC871\uD569\uB2C8\uB2E4. ticker=${ticker}, timeframe=${timeframe}, count=${aggregated.length}`
    );
  }
  return aggregated;
}

// timeframe-check.ts
var frames = ["1m", "3m", "5m", "15m", "30m", "1H"];
for (const tf of frames) {
  try {
    const rows = await getKiwoomChartCandles("005930", tf);
    const times = rows.map((r) => r.time);
    console.log(tf, "\uAC1C\uC218=", rows.length, "\uCCAB\uBD09=", times[0], "\uB458\uC9F8\uBD09=", times[1], "\uB9C8\uC9C0\uB9C9\uBD09=", times.at(-1));
  } catch (e) {
    console.log(tf, "\uC624\uB958=", e instanceof Error ? e.message : String(e));
  }
}
