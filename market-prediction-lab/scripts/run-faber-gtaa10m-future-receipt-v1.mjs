import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildFaberGtaaFutureLedgerV1 } from "../src/faber-gtaa10m-future-receipt-v1.js";
import { FABER_GTAA_10M_FUTURE_HYPOTHESIS_V1 as H } from "../src/faber-gtaa10m-future-hypothesis-v1.js";

const START = Date.parse("2025-01-01T00:00:00.000Z");
const FRED_TB3MS_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=TB3MS";

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

async function fetchJson(url, label) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}_TIMEOUT`)), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          accept: "application/json,text/plain,*/*",
          "accept-language": "en-US,en;q=0.9",
          "user-agent": "Mozilla/5.0 faber-gtaa-future-oos/1.0",
        },
      });
      if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
      return await response.json();
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error(`${label}_FAILED`);
}

async function fetchText(url, label) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`${label}_TIMEOUT`)), 20_000);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        redirect: "follow",
        headers: {
          accept: "text/csv,text/plain,*/*",
          "user-agent": "faber-gtaa-future-oos/1.0",
        },
      });
      if (!response.ok) throw new Error(`${label}_HTTP_${response.status}`);
      return await response.text();
    } catch (error) {
      last = error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw last ?? new Error(`${label}_FAILED`);
}

async function collectYahooAdjusted(symbol) {
  const end = Date.now() + 2 * 86_400_000;
  const query = `period1=${Math.floor(START / 1000)}&period2=${Math.ceil(end / 1000)}&interval=1d&events=history&includeAdjustedClose=true`;
  let payload = null;
  let last = null;
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      payload = await fetchJson(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?${query}`,
        `YAHOO_${symbol}`,
      );
      if (payload?.chart?.result?.[0]) break;
    } catch (error) {
      last = error;
    }
  }
  const result = payload?.chart?.result?.[0];
  if (!result) throw last ?? new Error(`YAHOO_${symbol}_EMPTY`);

  const timestamps = Array.isArray(result.timestamp) ? result.timestamp : [];
  const quote = result?.indicators?.quote?.[0] ?? {};
  const adjusted = result?.indicators?.adjclose?.[0]?.adjclose ?? [];
  const daily = [];
  for (let i = 0; i < timestamps.length; i += 1) {
    const timestamp = Number(timestamps[i]) * 1000;
    const open = Number(quote.open?.[i]);
    const close = Number(quote.close?.[i]);
    const adjustedClose = Number(adjusted?.[i]);
    if (![timestamp, open, close, adjustedClose].every(Number.isFinite)) continue;
    if (!(timestamp > 0 && open > 0 && close > 0 && adjustedClose > 0)) continue;
    const factor = adjustedClose / close;
    daily.push({
      timestamp,
      date: new Date(timestamp).toISOString().slice(0, 10),
      adjustedOpen: open * factor,
      adjustedClose,
    });
  }
  daily.sort((a, b) => a.timestamp - b.timestamp);
  if (daily.length < 300) throw new Error(`YAHOO_${symbol}_HISTORY_INSUFFICIENT_${daily.length}`);

  const grouped = new Map();
  for (const row of daily) {
    const month = monthKey(row.timestamp);
    const list = grouped.get(month) ?? [];
    list.push(row);
    grouped.set(month, list);
  }
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, rows]) => ({
    month,
    firstOpen: rows[0].adjustedOpen,
    lastClose: rows.at(-1).adjustedClose,
    firstDate: rows[0].date,
    lastDate: rows.at(-1).date,
    dailyCount: rows.length,
  }));
}

async function collectTb3ms() {
  const text = await fetchText(FRED_TB3MS_URL, "FRED_TB3MS");
  const rows = text.trim().split(/\r?\n/u);
  const header = rows.shift()?.split(",") ?? [];
  const dateIndex = header.findIndex((value) => /DATE|observation_date/iu.test(value));
  const valueIndex = header.findIndex((value) => value.trim().toUpperCase() === "TB3MS");
  if (dateIndex < 0 || valueIndex < 0) throw new Error("FRED_TB3MS_SCHEMA");

  const monthly = {};
  for (const line of rows) {
    const cells = line.split(",");
    const date = String(cells[dateIndex] ?? "").trim();
    const annualPercent = Number(cells[valueIndex]);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date) || !Number.isFinite(annualPercent)) continue;
    monthly[date.slice(0, 7)] = annualPercent / 1200;
  }
  if (Object.keys(monthly).length < 200) {
    throw new Error(`FRED_TB3MS_INSUFFICIENT_${Object.keys(monthly).length}`);
  }
  return monthly;
}

async function main() {
  const monthlyBySymbol = {};
  for (const sleeve of H.fixedRules.sleeves) {
    monthlyBySymbol[sleeve.symbol] = await collectYahooAdjusted(sleeve.symbol);
  }
  const cashReturnsByMonth = await collectTb3ms();
  const ledger = buildFaberGtaaFutureLedgerV1({
    monthlyBySymbol,
    cashReturnsByMonth,
    generatedAt: new Date().toISOString(),
  });

  const report = {
    ...ledger,
    dataProvenance: {
      equityProvider: "Yahoo public chart adjusted price",
      cashProvider: "FRED TB3MS",
      fetchedAt: new Date().toISOString(),
      symbols: H.fixedRules.sleeves.map((sleeve) => sleeve.symbol),
      privateProviderUsed: false,
      accountDataUsed: false,
    },
  };

  const out = resolve(process.argv[2] ?? "docs/us-faber-gtaa10m-future-receipt-v1.json");
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    status: report.status,
    hypothesisId: report.hypothesisId,
    declarationCommitSha: report.declarationCommitSha,
    latestSignalMonth: report.latestSignalMonth,
    settledFutureOosSamples: report.settledFutureOosSamples,
    economicSampleCredit: report.economicSampleCredit,
    profitabilityClaimAllowed: report.profitabilityClaimAllowed,
    executionAuthority: report.executionAuthority,
    latestReceipt: report.receipts.at(-1) ? {
      signalMonth: report.receipts.at(-1).signalMonth,
      holdingMonth: report.receipts.at(-1).holdingMonth,
      status: report.receipts.at(-1).status,
      receiptDigest: report.receipts.at(-1).receiptDigest,
      portfolioReturn: report.receipts.at(-1).portfolioReturn,
      futureOosEconomicSampleCredit: report.receipts.at(-1).futureOosEconomicSampleCredit,
    } : null,
  }));
}

await main();
