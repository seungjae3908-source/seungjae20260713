import { resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
import { appendCollectedRecord, saveCollectedSnapshot } from "../src/collector-state.js";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const market = args.market ?? "CRYPTO_FUTURES";
const symbol = (args.symbol ?? "BTCUSDT").toUpperCase();
const timeframe = args.timeframe ?? "15m";
const days = Number(args.days ?? 52);
if (!Number.isFinite(days) || days <= 0 || days > 3650) throw new Error("--days must be greater than 0 and at most 3650");
const endTime = Date.now();
const startTime = endTime - Math.floor(days * 24 * 60 * 60 * 1000);
const outputRoot = resolve(args.output ?? "data/bitget-shadow");
const client = new BitgetPublicClient({ minIntervalMs: 150, maxRetries: 4, timeoutMs: 10_000 });

const candles = await collectBitgetCandles({
  client, market, symbol, timeframe, startTime, endTime,
  onPage: ({ page, received }) => console.log(`page ${page}: ${received} candles`),
});
const key = `${market}:${symbol}:${timeframe}`;
const statePath = resolve(outputRoot, "collector-state.json");
const dataPath = resolve(outputRoot, market.toLowerCase(), symbol, `candles-${timeframe}.json`);
const savedCandles = await saveCollectedSnapshot({ dataPath, statePath, key: `candles:${key}`, snapshot: candles });

let contextResult = null;
if (market === "CRYPTO_FUTURES") {
  const context = await collectBitgetFuturesContext({ client, symbol });
  const contextPath = resolve(outputRoot, market.toLowerCase(), symbol, "futures-context.jsonl");
  contextResult = await appendCollectedRecord({
    filePath: contextPath,
    statePath,
    key: `context:${market}:${symbol}`,
    record: context,
  });
}

console.log(JSON.stringify({
  key,
  candleCount: candles.candles.length,
  candlesChanged: savedCandles.changed,
  candlesHash: savedCandles.hash,
  dataPath,
  contextChanged: contextResult?.changed ?? null,
}, null, 2));
