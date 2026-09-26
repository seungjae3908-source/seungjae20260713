import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BitgetPublicClient } from "../src/bitget-public-client.js";
import { collectBitgetCandles, collectBitgetFuturesContext } from "../src/bitget-candle-collector.js";
import { runBitgetLiveVerification } from "../src/live-verification.js";

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

async function writeJsonAtomically(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporaryPath, filePath);
}

const args = parseArgs(process.argv.slice(2));
const market = args.market ?? "CRYPTO_FUTURES";
const symbol = (args.symbol ?? "BTCUSDT").toUpperCase();
const timeframe = args.timeframe ?? "15m";
const days = Number(args.days ?? 7);
const outputPath = resolve(args.output ?? `data/bitget-shadow/reports/${symbol}-${timeframe}-live-quality.json`);
const client = new BitgetPublicClient({ minIntervalMs: 150, maxRetries: 4, timeoutMs: 10_000 });

const result = await runBitgetLiveVerification({
  client,
  collectCandles: collectBitgetCandles,
  collectContext: collectBitgetFuturesContext,
  market,
  symbol,
  timeframe,
  days,
});
await writeJsonAtomically(outputPath, result.report);
console.log(JSON.stringify({ outputPath, ...result.report }, null, 2));
if (result.report.status === "fail") process.exitCode = 2;
