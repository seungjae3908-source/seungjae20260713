import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildStockHistoricalDataset, buildStockHistoryProviderCapability } from "../src/stock-history-provider.js";

function args(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const value = argv[index + 1];
    if (value == null || value.startsWith("--")) throw new Error(`missing value for --${key}`);
    result[key] = value;
    index += 1;
  }
  return result;
}

function parseDate(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) throw new Error(`${label} must be YYYY-MM-DD`);
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isSafeInteger(timestamp)) throw new Error(`${label} is invalid`);
  return timestamp;
}

const input = args(process.argv.slice(2));
const market = input.market;
const symbol = input.symbol;
const requestedStart = parseDate(input.start, "start");
const requestedEnd = parseDate(input.end, "end");
if (!market || !symbol) throw new Error("--market and --symbol are required");
if (!input.output) throw new Error("--output is required");

const capability = buildStockHistoryProviderCapability({ market, env: process.env });
if (capability.status !== "configured") {
  process.stderr.write(`${JSON.stringify({
    ok: false,
    market,
    symbol,
    status: capability.status,
    provider: capability.provider,
    reason: capability.reason,
    credentialEnvironmentVariable: capability.credentialEnvironmentVariable,
    credentialPresent: capability.credentialPresent,
    credentialValueExposed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  })}\n`);
  process.exitCode = 2;
} else {
  const generatedAt = Date.now();
  const result = await buildStockHistoricalDataset({
    market,
    symbol,
    requestedStart,
    requestedEnd,
    generatedAt,
    env: process.env,
  });
  const outputPath = resolve(input.output);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify({
    schema: "stock-history-collection-v1",
    generatedAt,
    capability: result.capability,
    collection: result.collection,
    dataset: result.dataset,
    safety: {
      syntheticDataUsed: false,
      privateApiUsed: false,
      liveOrderAllowed: false,
      orderSubmitted: false,
      credentialValuePersisted: false,
    },
  }, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    market,
    symbol,
    provider: result.dataset.provider,
    candleCount: result.dataset.candles.length,
    dataQuality: result.dataset.dataQuality,
    corporateActions: result.dataset.corporateActions,
    survivorshipSafeguard: result.dataset.survivorshipSafeguard,
    actualStart: result.dataset.actualStart,
    actualEnd: result.dataset.actualEnd,
    output: outputPath,
    credentialValueExposed: false,
    privateApiUsed: false,
    orderSubmitted: false,
  })}\n`);
}
