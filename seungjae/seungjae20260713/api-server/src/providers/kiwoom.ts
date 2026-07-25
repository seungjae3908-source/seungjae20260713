/**
 * Kiwoom REST API provider.
 *
 * Required Replit Secrets:
 * - KIWOOM_APP_KEY
 * - KIWOOM_APP_SECRET
 * - KIWOOM_PROXY_KEY
 * - KIWOOM_MODE=real | mock
 */

const REAL_BASE_URL =
  process.env.KIWOOM_BASE_URL?.trim() ||
  "http://158.247.235.32:3000/kiwoom";

const MOCK_BASE_URL = "https://mockapi.kiwoom.com";
const REQUEST_TIMEOUT_MS = 15_000;

const UINT32_MAX = 4_294_967_295;
const INT32_MAX = 2_147_483_647;

export type KiwoomMarket = "KR" | "US";

export type KiwoomRankingType =
  | "volume"
  | "tradingValue"
  | "gainers"
  | "losers";

export type KiwoomAssetType =
  | "STOCK"
  | "ETF"
  | "ETN"
  | "REIT"
  | "SPAC"
  | "UNKNOWN";

export type KiwoomRiskLevel =
  | "NORMAL"
  | "CAUTION"
  | "HIGH";

export type KiwoomRankingAssetFilter =
  | "all"
  | "stocks"
  | "etp";

export interface KiwoomRankingOptions {
  assetFilter?: KiwoomRankingAssetFilter;
  excludeHighRisk?: boolean;
  recommendationEligibleOnly?: boolean;
}

export interface KiwoomApiResponse {
  return_code?: number | string;
  return_msg?: string;
  [key: string]: unknown;
}

export interface KiwoomRankingRow {
  ticker: string;
  name: string;
  market: KiwoomMarket;
  currency: "KRW" | "USD";

  price: number | null;
  changePercent: number | null;
  volume: number | null;
  tradingValue: number | null;

  rank: number;
  sourceRank: number;

  assetType: KiwoomAssetType;
  isEtp: boolean;
  isLeveraged: boolean;
  isInverse: boolean;
  isDerivative: boolean;
  riskLevel: KiwoomRiskLevel;
  recommendationEligible: boolean;

  dataQualityWarnings: string[];

  reason: string;
  provider: "kiwoom";
  raw: Record<string, unknown>;
}

interface TokenResponse extends KiwoomApiResponse {
  expires_dt?: string;
  token_type?: string;
  token?: string;
}

interface RequestOptions {
  apiId: string;
  path: string;
  body: Record<string, unknown>;
  contYn?: string;
  nextKey?: string;
  retryAuth?: boolean;
  retryRateLimit?: number;
}

interface PickedEntry {
  key: string;
  value: unknown;
}

interface NormalizedVolume {
  value: number | null;
  warning: string | null;
}

interface InstrumentClassification {
  assetType: KiwoomAssetType;
  isEtp: boolean;
  isLeveraged: boolean;
  isInverse: boolean;
  isDerivative: boolean;
  riskLevel: KiwoomRiskLevel;
  recommendationEligible: boolean;
}

let tokenCache: {
  token: string;
  expiresAt: number;
} | null = null;

let requestQueue: Promise<void> = Promise.resolve();
let nextRequestAt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForRequestSlot(): Promise<void> {
  const previous = requestQueue;
  let release: () => void = () => undefined;
  requestQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previous;
  const minimumInterval = isMockMode() ? 260 : 240;
  const wait = Math.max(0, nextRequestAt - Date.now());
  if (wait > 0) await sleep(wait);
  nextRequestAt = Date.now() + minimumInterval;
  release();
}

function isMockMode(): boolean {
  return (
    process.env.KIWOOM_MODE
      ?.trim()
      .toLowerCase() === "mock"
  );
}

function baseUrl(): string {
  return isMockMode()
    ? MOCK_BASE_URL
    : REAL_BASE_URL;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(
      `${name} 환경변수가 등록되지 않았습니다.`,
    );
  }

  return value;
}

/**
 * 실전 모드에서는 Vultr 프록시 인증키를 모든 요청에 포함합니다.
 * mock 모드에서는 키움 mock 서버로 직접 접속하므로 프록시 헤더를 보내지 않습니다.
 */
function proxyHeaders(): Record<string, string> {
  if (isMockMode()) {
    return {};
  }

  return {
    "x-proxy-key": requireEnv(
      "KIWOOM_PROXY_KEY",
    ),
  };
}

function toNumber(
  value: unknown,
): number | null {
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
    .replace(/[,+%₩$]/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);

  return Number.isFinite(parsed)
    ? parsed
    : null;
}

function absoluteNumber(
  value: unknown,
): number | null {
  const parsed = toNumber(value);

  return parsed == null
    ? null
    : Math.abs(parsed);
}

function normalizeVolume(
  value: unknown,
): NormalizedVolume {
  const parsed = absoluteNumber(value);

  if (parsed == null) {
    return {
      value: null,
      warning: null,
    };
  }

  if (parsed === UINT32_MAX) {
    return {
      value: null,
      warning:
        "키움 응답 거래량이 UINT32 최대값(4,294,967,295)으로 반환되어 유효하지 않은 값으로 처리했습니다.",
    };
  }

  if (parsed === INT32_MAX) {
    return {
      value: null,
      warning:
        "키움 응답 거래량이 INT32 최대값(2,147,483,647)으로 반환되어 유효하지 않은 값으로 처리했습니다.",
    };
  }

  if (!Number.isSafeInteger(parsed)) {
    return {
      value: null,
      warning:
        "거래량이 JavaScript 안전 정수 범위를 벗어나 유효하지 않은 값으로 처리했습니다.",
    };
  }

  return {
    value: parsed,
    warning: null,
  };
}

async function readJson(
  response: Response,
): Promise<Record<string, unknown>> {
  const text = await response.text();

  if (!text) {
    return {};
  }

  try {
    return JSON.parse(
      text,
    ) as Record<string, unknown>;
  } catch {
    throw new Error(
      `키움 API가 JSON이 아닌 응답을 반환했습니다. HTTP ${response.status}: ${text.slice(0, 240)}`,
    );
  }
}

function returnCode(
  data: Record<string, unknown>,
): number {
  const raw = data.return_code;

  if (raw == null || raw === "") {
    return 0;
  }

  const parsed = Number(raw);

  return Number.isFinite(parsed)
    ? parsed
    : -1;
}

function returnMessage(
  data: Record<string, unknown>,
): string {
  return (
    typeof data.return_msg === "string" &&
    data.return_msg.trim()
  )
    ? data.return_msg
    : "알 수 없는 키움 API 오류";
}

export function clearKiwoomTokenCache(): void {
  tokenCache = null;
}

export function isKiwoomConfigured(): boolean {
  return Boolean(
    process.env.KIWOOM_APP_KEY?.trim() &&
      process.env.KIWOOM_APP_SECRET?.trim() &&
      (
        isMockMode() ||
        process.env.KIWOOM_PROXY_KEY?.trim()
      ),
  );
}

export function getKiwoomStatus() {
  return {
    provider: "kiwoom",

    mode: isMockMode()
      ? "mock"
      : "real",

    providerEndpointConfigured: Boolean(process.env.KIWOOM_BASE_URL),

    appKeyRegistered: Boolean(
      process.env.KIWOOM_APP_KEY?.trim(),
    ),

    appSecretRegistered: Boolean(
      process.env.KIWOOM_APP_SECRET?.trim(),
    ),

    proxyKeyRegistered:
      isMockMode() ||
      Boolean(
        process.env.KIWOOM_PROXY_KEY?.trim(),
      ),

    tokenCached: Boolean(
      tokenCache &&
        Date.now() <
          tokenCache.expiresAt - 60_000,
    ),
  };
}

export async function getKiwoomToken(): Promise<string> {
  if (
    tokenCache &&
    Date.now() <
      tokenCache.expiresAt -
        5 * 60 * 1000
  ) {
    return tokenCache.token;
  }

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  try {
    const response = await fetch(
      `${baseUrl()}/oauth2/token`,
      {
        method: "POST",

        headers: {
          Accept: "application/json",
          "Content-Type":
            "application/json;charset=UTF-8",
          ...proxyHeaders(),
        },

        body: JSON.stringify({
          grant_type:
            "client_credentials",
          appkey: requireEnv(
            "KIWOOM_APP_KEY",
          ),
          secretkey: requireEnv(
            "KIWOOM_APP_SECRET",
          ),
        }),

        signal: controller.signal,
      },
    );

    const result =
      (await readJson(
        response,
      )) as TokenResponse;

    if (
      !response.ok ||
      returnCode(result) !== 0 ||
      !result.token
    ) {
      throw new Error(
        `키움 토큰 발급 실패: ${returnMessage(result)} (HTTP ${response.status})`,
      );
    }

    tokenCache = {
      token: result.token,
      expiresAt:
        Date.now() +
        23 * 60 * 60 * 1000,
    };

    return result.token;
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        "키움 토큰 요청 시간이 초과되었습니다.",
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function kiwoomRequest<
  T extends KiwoomApiResponse =
    KiwoomApiResponse,
>({
  apiId,
  path,
  body,
  contYn,
  nextKey,
  retryAuth = true,
  retryRateLimit = 0,
}: RequestOptions): Promise<{
  data: T;
  contYn: string | null;
  nextKey: string | null;
}> {
  const token =
    await getKiwoomToken();

  await waitForRequestSlot();

  const controller =
    new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    REQUEST_TIMEOUT_MS,
  );

  const headers:
    Record<string, string> = {
      Accept: "application/json",

      "Content-Type":
        "application/json;charset=UTF-8",

      authorization:
        `Bearer ${token}`,

      "api-id": apiId,

      ...proxyHeaders(),
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
        signal: controller.signal,
      },
    );

    const result =
      (await readJson(response)) as T;

    if (
      !response.ok ||
      returnCode(result) !== 0
    ) {
      const message = returnMessage(result);
      const rateLimited =
        response.status === 429 ||
        returnCode(result) === 1700 ||
        /요청 개수|too many|rate limit/i.test(message);

      if (rateLimited && retryRateLimit < 4) {
        clearTimeout(timeout);
        await sleep(700 * Math.pow(2, retryRateLimit));
        return kiwoomRequest<T>({
          apiId,
          path,
          body,
          contYn,
          nextKey,
          retryAuth,
          retryRateLimit: retryRateLimit + 1,
        });
      }

      const authExpired =
        response.status === 401 ||
        response.status === 403 ||
        returnCode(result) === 8005 ||
        message.toLowerCase().includes("token");

      if (authExpired) {
        clearKiwoomTokenCache();
        if (retryAuth) {
          return kiwoomRequest<T>({ apiId, path, body, contYn, nextKey, retryAuth: false, retryRateLimit });
        }
      }

      throw new Error(
        `키움 ${apiId} 요청 실패: ${message} (HTTP ${response.status})`,
      );
    }

    return {
      data: result,
      contYn:
        response.headers.get(
          "cont-yn",
        ),
      nextKey:
        response.headers.get(
          "next-key",
        ),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "AbortError"
    ) {
      throw new Error(
        `키움 ${apiId} 요청 시간이 초과되었습니다.`,
      );
    }

    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function getKiwoomDomesticOrderbook(
  ticker: string,
): Promise<KiwoomApiResponse> {
  const normalizedTicker = ticker
    .trim()
    .toUpperCase();

  if (
    !/^[0-9A-Z]{6}(?:_(?:NX|AL))?$/.test(
      normalizedTicker,
    )
  ) {
    throw new Error(
      `잘못된 국내 종목코드입니다: ${normalizedTicker}`,
    );
  }

  const result =
    await kiwoomRequest({
      apiId: "ka10004",
      path: "/api/dostk/mrkcond",

      body: {
        stk_cd:
          normalizedTicker,
      },
    });

  return result.data;
}

function domesticRankingRequest(
  type: KiwoomRankingType,
): RequestOptions {
  const common = {
    mrkt_tp: "000",
    mang_stk_incls: "0",
    stex_tp: "1",
  };

  if (type === "volume") {
    return {
      apiId: "ka10030",
      path: "/api/dostk/rkinfo",

      body: {
        ...common,
        sort_tp: "1",
        crd_tp: "0",
        trde_qty_tp: "0",
        pric_tp: "0",
        trde_prica_tp: "0",
        mrkt_open_tp: "0",
      },
    };
  }

  if (
    type === "tradingValue"
  ) {
    return {
      apiId: "ka10032",
      path: "/api/dostk/rkinfo",
      body: common,
    };
  }

  return {
    apiId: "ka10027",
    path: "/api/dostk/rkinfo",

    body: {
      ...common,

      sort_tp:
        type === "losers"
          ? "3"
          : "1",

      trde_qty_cnd: "0000",
      stk_cnd: "0",
      crd_cnd: "0",
      updown_incls: "1",
      pric_cnd: "0",
      trde_prica_cnd: "0",
    },
  };
}

function usRankingRequests(
  type: KiwoomRankingType,
): RequestOptions[] {
  if (type === "volume") {
    return [
      {
        apiId: "usa20530",
        path: "/api/us/rkinfo",

        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: "1",
        },
      },
    ];
  }

  if (
    type === "tradingValue"
  ) {
    return [
      {
        apiId: "usa20540",
        path: "/api/us/rkinfo",

        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: "1",
        },
      },
    ];
  }

  if (type === "gainers") {
    return [
      {
        apiId: "usa20910",
        path: "/api/us/rkinfo",

        body: {
          excd: "000",
          item_tp: "1",
          sort_tp: "1",
        },
      },
    ];
  }

  return [
    {
      apiId: "usa20910",
      path: "/api/us/rkinfo",

      body: {
        excd: "000",
        item_tp: "1",
        sort_tp: "4",
      },
    },

    {
      apiId: "usa20910",
      path: "/api/us/rkinfo",

      body: {
        excd: "000",
        item_tp: "1",
        sort_tp: "5",
      },
    },

    {
      apiId: "usa20910",
      path: "/api/us/rkinfo",

      body: {
        excd: "000",
        item_tp: "1",
        sort_tp: "2",
      },
    },
  ];
}

function objectRows(
  value: unknown,
  depth = 0,
): Record<string, unknown>[] {
  if (depth > 4) {
    return [];
  }

  if (Array.isArray(value)) {
    return value.filter(
      (
        item,
      ): item is Record<
        string,
        unknown
      > =>
        Boolean(item) &&
        typeof item ===
          "object" &&
        !Array.isArray(item),
    );
  }

  if (
    !value ||
    typeof value !== "object"
  ) {
    return [];
  }

  const entries = Object.entries(
    value as Record<
      string,
      unknown
    >,
  );

  const directArrays = entries
    .filter(([, nested]) =>
      Array.isArray(nested),
    )
    .sort(
      (a, b) =>
        (b[1] as unknown[])
          .length -
        (a[1] as unknown[])
          .length,
    );

  for (
    const [, nested]
    of directArrays
  ) {
    const rows = objectRows(
      nested,
      depth + 1,
    );

    if (rows.length > 0) {
      return rows;
    }
  }

  for (
    const [, nested]
    of entries
  ) {
    const rows = objectRows(
      nested,
      depth + 1,
    );

    if (rows.length > 0) {
      return rows;
    }
  }

  return [];
}

function rankingRows(
  data: Record<string, unknown>,
): Record<string, unknown>[] {
  const resultList =
    data.result_list;

  if (
    Array.isArray(resultList)
  ) {
    const rows =
      objectRows(resultList);

    if (rows.length > 0) {
      return rows;
    }
  }

  return objectRows(data);
}

function pick(
  row: Record<string, unknown>,
  keys: string[],
): unknown {
  for (const key of keys) {
    if (
      row[key] != null &&
      row[key] !== ""
    ) {
      return row[key];
    }
  }

  return undefined;
}

function pickEntry(
  row: Record<string, unknown>,
  keys: string[],
): PickedEntry | null {
  for (const key of keys) {
    if (
      row[key] != null &&
      row[key] !== ""
    ) {
      return {
        key,
        value: row[key],
      };
    }
  }

  return null;
}

function normalizeTradingValue(
  row: Record<string, unknown>,
  market: KiwoomMarket,
): number | null {
  const entry = pickEntry(
    row,
    [
      "trde_amt",
      "trde_prica",
      "trading_value",
      "acml_tr_pbmn",
      "acml_trading_value",
      "acc_trde_prica",
      "amount",
      "trade_amount",
      "trd_amt",
      "turnover",
    ],
  );

  if (!entry) {
    return null;
  }

  const parsed =
    absoluteNumber(entry.value);

  if (parsed == null) {
    return null;
  }

  /*
   * 국내 키움 거래대금 순위의
   * trde_amt/trde_prica는
   * 백만원 단위이므로 원화로 변환합니다.
   */
  if (
    market === "KR" &&
    (
      entry.key ===
        "trde_amt" ||
      entry.key ===
        "trde_prica"
    )
  ) {
    return parsed * 1_000_000;
  }

  /*
   * 미국 키움 거래량·거래대금 순위의
   * trde_prica는 천 달러 단위이므로
   * 실제 달러 금액으로 변환합니다.
   */
  if (
    market === "US" &&
    (
      entry.key ===
        "trde_prica" ||
      entry.key ===
        "acc_trde_prica"
    )
  ) {
    return parsed * 1_000;
  }

  return parsed;
}

function containsAny(
  text: string,
  keywords: string[],
): boolean {
  return keywords.some(
    (keyword) =>
      text.includes(keyword),
  );
}

export function classifyKiwoomInstrument(
  name: string,
  market: KiwoomMarket,
): InstrumentClassification {
  const normalizedName = name
    .replace(/\s+/g, " ")
    .trim();

  const upperName =
    normalizedName.toUpperCase();

  const compactName =
    upperName.replace(/\s+/g, "");

  const isEtn =
    /\bETN\b/i.test(
      upperName,
    ) ||
    containsAny(
      compactName,
      [
        "상장지수증권",
        "레버리지ETN",
        "인버스ETN",
      ],
    );

  const koreanEtfBrand =
    /^(KODEX|TIGER|RISE|ACE|SOL|PLUS|HANARO|KOSEF|ARIRANG|TIMEFOLIO|WOORI|FOCUS|KIWOOM|KBSTAR|1Q|BNK|히어로즈|마이티)(\s|$)/i.test(
      normalizedName,
    );

  const overseasEtfName =
    /\bETF\b/i.test(
      upperName,
    ) ||
    /\bEXCHANGE TRADED FUND\b/i.test(
      upperName,
    );

  const isEtf =
    !isEtn &&
    (
      koreanEtfBrand ||
      overseasEtfName ||
      containsAny(
        compactName,
        [
          "상장지수펀드",
          "단일종목레버리지",
          "선물인버스",
          "코스닥150레버리지",
          "코스닥150선물인버스",
        ],
      )
    );

  const isWarrant =
    containsAny(
      compactName,
      [
        "WARRANT",
        "WARRANTS",
        "C/WTS",
        "WTS",
        "워런트",
        "신주인수권",
      ],
    );

  const isReit =
    containsAny(
      compactName,
      [
        "리츠",
        "REIT",
      ],
    ) &&
    !isEtf &&
    !isEtn &&
    !isWarrant;

  const isSpac =
    containsAny(
      compactName,
      [
        "스팩",
        "SPAC",
      ],
    ) &&
    !isEtf &&
    !isEtn &&
    !isWarrant;

  const isLeveraged =
    containsAny(
      compactName,
      [
        "레버리지",
        "2X",
        "3X",
        "BULL2X",
        "BULL3X",
      ],
    );

  const isInverse =
    containsAny(
      compactName,
      [
        "인버스",
        "INVERSE",
        "BEAR",
        "SHORT",
        "SHORT2X",
        "SHORT3X",
        "-1X",
        "-2X",
        "-3X",
      ],
    );

  const derivativeKeyword =
    containsAny(
      compactName,
      [
        "선물",
        "FUTURES",
        "옵션",
        "OPTION",
      ],
    );

  const isDerivative =
    isLeveraged ||
    isInverse ||
    derivativeKeyword ||
    isWarrant;

  let assetType:
    KiwoomAssetType =
      "UNKNOWN";

  if (isEtn) {
    assetType = "ETN";
  } else if (isEtf) {
    assetType = "ETF";
  } else if (isWarrant) {
    assetType = "UNKNOWN";
  } else if (isReit) {
    assetType = "REIT";
  } else if (isSpac) {
    assetType = "SPAC";
  } else if (
    market === "KR"
  ) {
    assetType = "STOCK";
  } else if (
    !/\bFUND\b/i.test(
      upperName,
    ) &&
    !/\bTRUST\b/i.test(
      upperName,
    ) &&
    !/\bUNIT\b/i.test(
      upperName,
    )
  ) {
    assetType = "STOCK";
  }

  const isEtp =
    assetType === "ETF" ||
    assetType === "ETN";

  let riskLevel:
    KiwoomRiskLevel =
      "NORMAL";

  if (
    assetType === "ETN" ||
    isLeveraged ||
    isInverse ||
    isDerivative
  ) {
    riskLevel = "HIGH";
  } else if (
    assetType === "ETF" ||
    assetType === "REIT" ||
    assetType === "SPAC" ||
    assetType === "UNKNOWN"
  ) {
    riskLevel = "CAUTION";
  }

  const recommendationEligible =
    assetType === "STOCK" &&
    riskLevel === "NORMAL" &&
    !isLeveraged &&
    !isInverse &&
    !isDerivative;

  return {
    assetType,
    isEtp,
    isLeveraged,
    isInverse,
    isDerivative,
    riskLevel,
    recommendationEligible,
  };
}

function rankingReason(
  type: KiwoomRankingType,
): string {
  if (type === "volume") {
    return "키움증권 거래량 상위 종목입니다.";
  }

  if (
    type === "tradingValue"
  ) {
    return "키움증권 거래대금 상위 종목입니다.";
  }

  if (type === "gainers") {
    return "키움증권 등락률 기준 급상승 종목입니다.";
  }

  return "키움증권 등락률 기준 급하락 종목입니다.";
}

function normalizeRankingRows(
  data: Record<string, unknown>,
  market: KiwoomMarket,
  type: KiwoomRankingType,
): KiwoomRankingRow[] {
  const rows =
    rankingRows(data);

  const result:
    KiwoomRankingRow[] = [];

  for (const row of rows) {
    const tickerRaw = pick(
      row,
      [
        "stk_cd",
        "stk_code",
        "symbol",
        "symb",
        "ticker",
        "ovrs_pdno",
        "eng_stk_cd",
        "code",
        "item_cd",
        "item_code",
      ],
    );

    const ticker = String(
      tickerRaw ?? "",
    )
      .trim()
      .toUpperCase();

    if (!ticker) {
      continue;
    }

    const name = String(
      pick(
        row,
        [
          "stk_nm",
          "stk_name",
          "name",
          "kor_nm",
          "ovrs_item_name",
          "item_nm",
          "item_name",
        ],
      ) ?? ticker,
    ).trim();

    const englishName =
      String(
        pick(
          row,
          [
            "stk_enm",
            "eng_nm",
            "eng_item_nm",
          ],
        ) ?? "",
      ).trim();

    const price =
      absoluteNumber(
        pick(
          row,
          [
            "cur_prc",
            "now_pric",
            "curr_pric",
            "last",
            "price",
            "ovrs_nmix_prpr",
            "last_pric",
            "close",
            "prpr",
          ],
        ),
      );

    const changePercent =
      toNumber(
        pick(
          row,
          [
            "flu_rt",
            "chg_rt",
            "change_rate",
            "changePercent",
            "prdy_ctrt",
            "rate",
            "diff_rate",
            "fluctuation_rate",
            "diff_rate_for_gjga",
          ],
        ),
      );

    const normalizedVolume =
      normalizeVolume(
        pick(
          row,
          [
            "acc_trde_qty",
            "acc_trd_qty",
            "acml_trde_qty",
            "acml_trd_qty",
            "trde_qty",
            "now_trde_qty",
            "volume",
            "acml_vol",
            "acml_volum",
            "tvol",
            "tot_qty",
            "trade_volume",
          ],
        ),
      );

    const tradingValue =
      normalizeTradingValue(
        row,
        market,
      );

    const classification =
      classifyKiwoomInstrument(
        `${name} ${englishName}`.trim(),
        market,
      );

    const dataQualityWarnings:
      string[] = [];

    if (
      normalizedVolume.warning
    ) {
      dataQualityWarnings.push(
        normalizedVolume.warning,
      );
    }

    const sourceRankValue =
      toNumber(
        pick(
          row,
          [
            "rank",
            "sourceRank",
            "kw_high_rank",
            "rnk",
          ],
        ),
      );

    const sourceRank =
      sourceRankValue == null
        ? result.length + 1
        : Math.max(
            1,
            Math.trunc(
              Math.abs(
                sourceRankValue,
              ),
            ),
          );

    result.push({
      ticker,
      name,
      market,

      currency:
        market === "KR"
          ? "KRW"
          : "USD",

      price,
      changePercent,
      volume:
        normalizedVolume.value,
      tradingValue,

      rank: sourceRank,
      sourceRank,

      assetType:
        classification.assetType,

      isEtp:
        classification.isEtp,

      isLeveraged:
        classification.isLeveraged,

      isInverse:
        classification.isInverse,

      isDerivative:
        classification.isDerivative,

      riskLevel:
        classification.riskLevel,

      recommendationEligible:
        classification
          .recommendationEligible,

      dataQualityWarnings,

      reason:
        rankingReason(type),

      provider: "kiwoom",
      raw: row,
    });
  }

  return result;
}

function sortRankingRows(
  rows: KiwoomRankingRow[],
  type: KiwoomRankingType,
): KiwoomRankingRow[] {
  return [...rows].sort(
    (a, b) => {
      if (type === "volume") {
        if (
          a.volume == null &&
          b.volume == null
        ) {
          return (
            a.sourceRank -
            b.sourceRank
          );
        }

        if (a.volume == null) {
          return 1;
        }

        if (b.volume == null) {
          return -1;
        }

        return (
          b.volume -
          a.volume
        );
      }

      if (
        type ===
        "tradingValue"
      ) {
        if (
          a.tradingValue ==
            null &&
          b.tradingValue ==
            null
        ) {
          return (
            a.sourceRank -
            b.sourceRank
          );
        }

        if (
          a.tradingValue ==
          null
        ) {
          return 1;
        }

        if (
          b.tradingValue ==
          null
        ) {
          return -1;
        }

        return (
          b.tradingValue -
          a.tradingValue
        );
      }

      if (
        type === "gainers"
      ) {
        return (
          (
            b.changePercent ??
            Number
              .NEGATIVE_INFINITY
          ) -
          (
            a.changePercent ??
            Number
              .NEGATIVE_INFINITY
          )
        );
      }

      if (
        type === "losers"
      ) {
        return (
          (
            a.changePercent ??
            Number
              .POSITIVE_INFINITY
          ) -
          (
            b.changePercent ??
            Number
              .POSITIVE_INFINITY
          )
        );
      }

      return (
        a.sourceRank -
        b.sourceRank
      );
    },
  );
}

function applyRankingOptions(
  rows: KiwoomRankingRow[],
  options:
    KiwoomRankingOptions,
  limit: number,
): KiwoomRankingRow[] {
  const assetFilter =
    options.assetFilter ??
    "all";

  const filtered = rows.filter(
    (row) => {
      if (
        assetFilter ===
          "stocks" &&
        (
          row.assetType !==
            "STOCK" ||
          row.isEtp ||
          row.isLeveraged ||
          row.isInverse ||
          row.isDerivative ||
          row.riskLevel ===
            "HIGH"
        )
      ) {
        return false;
      }

      if (
        assetFilter === "etp" &&
        row.assetType !==
          "ETF" &&
        row.assetType !==
          "ETN"
      ) {
        return false;
      }

      if (
        options
          .excludeHighRisk &&
        row.riskLevel ===
          "HIGH"
      ) {
        return false;
      }

      if (
        options
          .recommendationEligibleOnly &&
        !row
          .recommendationEligible
      ) {
        return false;
      }

      return true;
    },
  );

  return filtered
    .slice(0, limit)
    .map(
      (row, index) => ({
        ...row,
        rank: index + 1,
      }),
    );
}

function filterByDirection(
  rows: KiwoomRankingRow[],
  type: KiwoomRankingType,
): KiwoomRankingRow[] {
  return rows.filter(
    (row) => {
      if (
        type === "gainers"
      ) {
        return (
          row.changePercent !=
            null &&
          row.changePercent > 0
        );
      }

      if (
        type === "losers"
      ) {
        return (
          row.changePercent !=
            null &&
          row.changePercent < 0
        );
      }

      return true;
    },
  );
}

function finalizeRankingRows(
  data: Record<string, unknown>,
  market: KiwoomMarket,
  type: KiwoomRankingType,
  options:
    KiwoomRankingOptions,
  limit: number,
): KiwoomRankingRow[] {
  const normalizedRows =
    normalizeRankingRows(
      data,
      market,
      type,
    );

  const directionFilteredRows =
    filterByDirection(
      normalizedRows,
      type,
    );

  const sortedRows =
    sortRankingRows(
      directionFilteredRows,
      type,
    );

  return applyRankingOptions(
    sortedRows,
    options,
    limit,
  );
}

export async function getKiwoomRankings(
  market: KiwoomMarket,
  type: KiwoomRankingType,
  limit = 30,
  options:
    KiwoomRankingOptions = {},
): Promise<
  KiwoomRankingRow[]
> {
  const safeLimit =
    Math.max(
      1,
      Math.min(
        100,
        Math.trunc(
          limit || 30,
        ),
      ),
    );

  if (market === "KR") {
    const request =
      domesticRankingRequest(
        type,
      );

    const response =
      await kiwoomRequest(
        request,
      );

    const rows =
      finalizeRankingRows(
        response.data as Record<
          string,
          unknown
        >,
        market,
        type,
        options,
        safeLimit,
      );

    if (
      rows.length === 0
    ) {
      throw new Error(
        `조건에 맞는 키움 랭킹 종목이 없습니다. API=${request.apiId}, market=${market}, type=${type}.`,
      );
    }

    return rows;
  }

  const requests =
    usRankingRequests(type);

  const attemptMessages:
    string[] = [];

  for (
    const request
    of requests
  ) {
    try {
      const response =
        await kiwoomRequest(
          request,
        );

      const rows =
        finalizeRankingRows(
          response.data as Record<
            string,
            unknown
          >,
          market,
          type,
          options,
          safeLimit,
        );

      if (
        rows.length > 0
      ) {
        return rows;
      }

      attemptMessages.push(
        `${request.apiId}/sort_tp=${String(request.body.sort_tp)}: 조건에 맞는 일반주식 0개`,
      );
    } catch (error) {
      attemptMessages.push(
        `${request.apiId}/sort_tp=${String(request.body.sort_tp)}: ${
          error instanceof Error
            ? error.message
            : "알 수 없는 오류"
        }`,
      );
    }
  }

  throw new Error(
    `미국 키움 랭킹 조회에 실패했습니다. market=${market}, type=${type}. 시도 결과: ${attemptMessages.join(" | ")}`,
  );
}

export interface KiwoomDomesticOrderInput {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  orderType?: "market" | "limit";
  price?: number | null;
}

export interface KiwoomDomesticOrderResult {
  ticker: string;
  side: "buy" | "sell";
  quantity: number;
  orderNo: string | null;
  raw: KiwoomApiResponse;
}

export type KiwoomUsExchange = "NASDAQ" | "NYSE" | "AMEX";

export interface KiwoomUsOrderInput {
  ticker: string;
  exchange: KiwoomUsExchange;
  side: "buy" | "sell";
  quantity: number;
  orderType?: "market" | "limit";
  price?: number | null;
}

export interface KiwoomUsOrderResult {
  ticker: string;
  exchange: KiwoomUsExchange;
  side: "buy" | "sell";
  quantity: number;
  orderNo: string | null;
  raw: KiwoomApiResponse;
}

/**
 * 국내주식 실제 주문 전송.
 * 기본 API ID/경로/거래구분은 환경변수로 교체할 수 있어
 * 키움 계정별 최신 REST 규격에 맞게 조정할 수 있습니다.
 */
export async function placeKiwoomDomesticOrder(
  input: KiwoomDomesticOrderInput,
): Promise<KiwoomDomesticOrderResult> {
  const ticker = input.ticker.trim().toUpperCase();
  const quantity = Math.trunc(Number(input.quantity));
  const orderType = input.orderType ?? "market";
  const price = input.price == null ? null : Number(input.price);

  if (!/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    throw new Error(`잘못된 국내 종목코드입니다: ${ticker}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("주문 수량은 1주 이상 정수여야 합니다.");
  }
  if (orderType === "limit" && (!Number.isFinite(price) || Number(price) <= 0)) {
    throw new Error("지정가 주문 가격을 확인해 주세요.");
  }

  const apiId =
    input.side === "buy"
      ? process.env.KIWOOM_BUY_ORDER_API_ID?.trim() || "kt10000"
      : process.env.KIWOOM_SELL_ORDER_API_ID?.trim() || "kt10001";
  const path = process.env.KIWOOM_ORDER_PATH?.trim() || "/api/dostk/ordr";
  const marketTradeType =
    process.env.KIWOOM_MARKET_ORDER_TRADE_TYPE?.trim() || "3";
  const limitTradeType =
    process.env.KIWOOM_LIMIT_ORDER_TRADE_TYPE?.trim() || "0";

  const response = await kiwoomRequest({
    apiId,
    path,
    body: {
      dmst_stex_tp:
        process.env.KIWOOM_DOMESTIC_EXCHANGE?.trim() || "KRX",
      stk_cd: ticker,
      ord_qty: String(quantity),
      ord_uv: orderType === "limit" ? String(Math.round(Number(price))) : "",
      trde_tp: orderType === "limit" ? limitTradeType : marketTradeType,
      cond_uv: "",
    },
  });

  const raw = response.data as KiwoomApiResponse & Record<string, unknown>;
  const orderNo = String(
    raw.ord_no ?? raw.order_no ?? raw.ordNo ?? raw.orderNo ?? "",
  ).trim() || null;

  return {
    ticker,
    side: input.side,
    quantity,
    orderNo,
    raw,
  };
}

/**
 * 미국주식 실제 주문 전송.
 * 키움 REST API의 미국주식 주문(ust20000/ust20001) 규격을 사용합니다.
 */
export async function placeKiwoomUsOrder(
  input: KiwoomUsOrderInput,
): Promise<KiwoomUsOrderResult> {
  const ticker = input.ticker.trim().toUpperCase();
  const quantity = Math.trunc(Number(input.quantity));
  const orderType = input.orderType ?? "market";
  const price = input.price == null ? null : Number(input.price);

  if (!/^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker)) {
    throw new Error(`잘못된 미국 종목코드입니다: ${ticker}`);
  }
  if (!Number.isSafeInteger(quantity) || quantity <= 0) {
    throw new Error("주문 수량은 1주 이상 정수여야 합니다.");
  }
  if (orderType === "limit" && (!Number.isFinite(price) || Number(price) <= 0)) {
    throw new Error("지정가 주문 가격을 확인해 주세요.");
  }

  const exchangeCode: Record<KiwoomUsExchange, string> = {
    NASDAQ: "ND",
    NYSE: "NY",
    AMEX: "NA",
  };
  const apiId =
    input.side === "buy"
      ? process.env.KIWOOM_US_BUY_ORDER_API_ID?.trim() || "ust20000"
      : process.env.KIWOOM_US_SELL_ORDER_API_ID?.trim() || "ust20001";
  const path = process.env.KIWOOM_US_ORDER_PATH?.trim() || "/api/us/ordr";
  const marketTradeType =
    process.env.KIWOOM_US_MARKET_ORDER_TRADE_TYPE?.trim() || "03";
  const limitTradeType =
    process.env.KIWOOM_US_LIMIT_ORDER_TRADE_TYPE?.trim() || "00";
  const limitPrice = Number(price ?? 0)
    .toFixed(4)
    .replace(/\.?0+$/, "");

  const response = await kiwoomRequest({
    apiId,
    path,
    body: {
      stex_tp: exchangeCode[input.exchange],
      stk_cd: ticker,
      ord_qty: String(quantity),
      ord_uv: orderType === "limit" ? limitPrice : "",
      trde_tp: orderType === "limit" ? limitTradeType : marketTradeType,
    },
  });

  const raw = response.data as KiwoomApiResponse & Record<string, unknown>;
  const orderNo = String(
    raw.ord_no ?? raw.order_no ?? raw.ordNo ?? raw.orderNo ?? "",
  ).trim() || null;

  return {
    ticker,
    exchange: input.exchange,
    side: input.side,
    quantity,
    orderNo,
    raw,
  };
}

/** 키움 국내주식 공매도추이(ka10014) 원문 조회. */
export async function getKiwoomShortSellingRaw(tickerInput: string) {
  const ticker = tickerInput.trim().toUpperCase();
  if (!/^\d{6}(?:_(?:NX|AL))?$/.test(ticker)) {
    throw new Error(`잘못된 국내 종목코드입니다: ${ticker}`);
  }

  const formatDate = (date: Date) =>
    `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}`;
  const endDate = new Date();
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 31);

  const response = await kiwoomRequest({
    apiId: process.env.KIWOOM_SHORT_SELLING_API_ID?.trim() || "ka10014",
    path: process.env.KIWOOM_SHORT_SELLING_PATH?.trim() || "/api/dostk/shsa",
    body: {
      stk_cd: ticker,
      tm_tp: "1",
      strt_dt: formatDate(startDate),
      end_dt: formatDate(endDate),
    },
  });

  return response.data as KiwoomApiResponse & Record<string, unknown>;
}
