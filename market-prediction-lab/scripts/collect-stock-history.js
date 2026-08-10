import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildStockHistoryProviderCapability,
  prepareStockAutomatedResearchHistory,
} from "../src/stock-history-provider.js";

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
const researchCodeSha = input["research-code-sha"] ?? process.env.RESEARCH_CODE_SHA;
if (!market || !symbol) throw new Error("--market and --symbol are required");
if (!input.output) throw new Error("--output is required");
if (!/^[0-9a-f]{40}$/iu.test(researchCodeSha ?? "")) throw new Error("--research-code-sha or RESEARCH_CODE_SHA must be an immutable 40-character SHA");

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
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
  })}\n`);
  process.exitCode = 2;
} else {
  const generatedAt = Date.now();
  const result = await prepareStockAutomatedResearchHistory({
    market,
    symbol,
    requestedStart,
    requestedEnd,
    researchCodeSha,
    generatedAt,
    env: process.env,
  });
  if (result.status !== "ready_for_research") throw new Error(`unexpected stock research status: ${result.status}`);

  const outputPath = resolve(input.output);
  await mkdir(dirname(outputPath), { recursive: true });
  const artifact = {
    schema: "stock-history-collection-v2",
    generatedAt,
    researchCodeSha,
    capability: result.capability,
    automatedProviderCapability: result.automatedProviderCapability,
    collection: result.collection,
    dataset: result.dataset,
    cacheProvenance: result.cacheProvenance,
    finalHoldout: {
      ready: false,
      reason: result.finalHoldoutReason,
      selectionUsesHoldout: false,
      retuningAllowed: false,
    },
    safety: {
      syntheticDataUsed: false,
      privateApiUsed: false,
      liveOrderAllowed: false,
      privateAccountRequestAllowed: false,
      orderSubmitted: false,
      credentialValuePersisted: false,
    },
  };
  const serialized = JSON.stringify(artifact, null, 2);
  const credentialValue = process.env[result.capability.credentialEnvironmentVariable];
  if (credentialValue && serialized.includes(credentialValue)) throw new Error("provider credential value leaked into stock history artifact");
  await writeFile(outputPath, `${serialized}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({
    ok: true,
    market,
    symbol,
    provider: result.dataset.provider,
    providerVersion: result.dataset.providerVersion,
    candleCount: result.dataset.candles.length,
    dataQuality: result.dataset.dataQuality,
    corporateActions: result.dataset.corporateActions,
    survivorshipSafeguard: result.dataset.survivorshipSafeguard,
    finalHoldoutReady: false,
    actualStart: result.dataset.actualStart,
    actualEnd: result.dataset.actualEnd,
    cacheNamespace: result.cacheProvenance.cacheNamespace,
    output: outputPath,
    credentialValueExposed: false,
    privateApiUsed: false,
    liveOrderAllowed: false,
    privateAccountRequestAllowed: false,
    orderSubmitted: false,
  })}\n`);
}
