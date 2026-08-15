import { ScannerUniverseService } from "../../api-server/src/services/scanner-universe.service.ts";
import { collectYahooStockHistory } from "../src/yahoo-stock-history.js";
import { collectUpbitSpotHistory } from "../src/upbit-spot-history.js";
import { classifyProviderFailure } from "../src/public-coverage-audit-v1.js";

const DAY_MS = 86_400_000;
const UPBIT_BASE = "https://api.upbit.com";

function yahooSymbol(entry) {
  if (/\.K[QS]$/u.test(entry.ticker)) return entry.ticker;
  const exchange = String(entry.exchange ?? "").toUpperCase();
  return `${entry.ticker}${/KOSDAQ|코스닥/u.test(exchange) ? ".KQ" : ".KS"}`;
}

async function diagnoseKr(limit = 30) {
  const universe = await ScannerUniverseService.get("KR");
  const failures = [];
  let successes = 0;
  for (const entry of universe.entries) {
    if (failures.length >= limit) break;
    const now = Date.now();
    try {
      await collectYahooStockHistory({
        market: "KR_STOCK",
        symbol: yahooSymbol(entry),
        startTime: now - 420 * DAY_MS,
        endTime: now,
        timeoutMs: 1_800,
        fetchImpl: fetch,
      });
      successes += 1;
    } catch (error) {
      failures.push({
        symbol: entry.ticker,
        providerSymbol: yahooSymbol(entry),
        classification: classifyProviderFailure(error),
        name: error?.name ?? null,
        message: String(error?.message ?? error).slice(0, 600),
        cause: String(error?.cause?.message ?? error?.cause ?? "").slice(0, 300),
      });
    }
  }
  return { market: "KR_STOCK", successesBeforeSampleCap: successes, failures };
}

async function upbitMarkets() {
  const response = await fetch(`${UPBIT_BASE}/v1/market/all?isDetails=true`, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`UPBIT_MARKETS_HTTP_${response.status}`);
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).filter((row) => String(row?.market ?? "").startsWith("KRW-"));
}

async function diagnoseSpot(limit = 30) {
  const markets = await upbitMarkets();
  const failures = [];
  let successes = 0;
  for (const row of markets) {
    if (failures.length >= limit) break;
    const symbol = String(row.market).replace(/^KRW-/u, "");
    const now = Date.now();
    try {
      await collectUpbitSpotHistory({ symbol, startTime: now - 40 * DAY_MS, endTime: now, maxPages: 1, minIntervalMs: 0, fetchImpl: fetch });
      const orderbook = await fetch(`${UPBIT_BASE}/v1/orderbook?markets=${encodeURIComponent(row.market)}`, { headers: { accept: "application/json" } });
      if (!orderbook.ok) throw Object.assign(new Error(`UPBIT_ORDERBOOK_HTTP_${orderbook.status}`), { status: orderbook.status });
      const payload = await orderbook.json();
      if (!Array.isArray(payload) || !payload[0]?.orderbook_units?.[0]) throw new Error("UPBIT_ORDERBOOK_BAD_RESPONSE");
      successes += 1;
    } catch (error) {
      failures.push({
        symbol,
        market: row.market,
        classification: classifyProviderFailure(error),
        name: error?.name ?? null,
        message: String(error?.message ?? error).slice(0, 600),
        cause: String(error?.cause?.message ?? error?.cause ?? "").slice(0, 300),
      });
    }
  }
  return { market: "CRYPTO_SPOT", successesBeforeSampleCap: successes, failures };
}

const report = {
  generatedAt: new Date().toISOString(),
  safety: { liveTrading: false, realOrder: false, privateApi: false, financialMutationCount: 0 },
  results: [await diagnoseKr(), await diagnoseSpot()],
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
