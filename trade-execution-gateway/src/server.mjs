import http from "node:http";
import { fileURLToPath } from "node:url";
import { publicContract } from "./contracts.mjs";
import { GatewayError, PaperMockBrokerAdapter, TradeExecutionGateway } from "./gateway.mjs";
import { placeWorkspacePaperOrder, previewWorkspaceOrder } from "./workspace-bridge.mjs";
import { placeCoinPaperOrder, previewCoinPaperOrder } from "./coin-bridge.mjs";
import { reconcileOrderEvidence } from "./reconciliation.mjs";
import { normalizePublicMarketDataEvidence } from "./market-data-evidence.mjs";
import { assessAttestedExecutionGuards, assessExecutionGuards } from "./execution-guards.mjs";
import { buildBracketPlan, buildCancelReplacePlan, buildTrailingPlan } from "./order-plans.mjs";
import { FilePaperStateStore } from "./paper-state-store.mjs";
import { PublicMarketDataRuntimeRegistry } from "./public-websocket-runtime.mjs";
import { estimateExecutionCosts } from "./execution-costs.mjs";
import { analyzeExecutionQuality } from "./execution-quality.mjs";
import { comparePaperLiveParity } from "./parity-contract.mjs";
import { PAPER_MOCK_PROTECTION_CAPABILITIES } from "./server-failure-protection.mjs";
import { FileServerFailureProtectionStore } from "./server-failure-protection-store.mjs";
import { SupervisedPaperGateway } from "./supervised-paper-gateway.mjs";
import { PaperCompoundingCapitalManager } from "./paper-capital-manager.mjs";
import { FilePaperCapitalStateStore } from "./paper-capital-state-store.mjs";
import { CapitalManagedPaperGateway } from "./capital-managed-paper-gateway.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 16 * 1024;
const MARKETS = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];
const DEFAULT_STATE_PATH = fileURLToPath(new URL("../.state/paper-state.json", import.meta.url));
const DEFAULT_PROTECTION_STATE_PATH = fileURLToPath(new URL("../.state/server-failure-protection.json", import.meta.url));
const DEFAULT_CAPITAL_STATE_PATH = fileURLToPath(new URL("../.state/paper-compounding-capital.json", import.meta.url));

function boundedPort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : DEFAULT_PORT;
}

function positiveEnv(name) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function buildPaperPolicy() {
  const maxQuantityByMarket = {};
  const maxNotionalByMarket = {};
  for (const market of MARKETS) {
    const maxQuantity = positiveEnv(`TEG_PAPER_MAX_QUANTITY_${market}`);
    const maxNotional = positiveEnv(`TEG_PAPER_MAX_NOTIONAL_${market}`);
    if (maxQuantity !== undefined) maxQuantityByMarket[market] = maxQuantity;
    if (maxNotional !== undefined) maxNotionalByMarket[market] = maxNotional;
  }
  return { maxQuantityByMarket, maxNotionalByMarket };
}

function buildSupervisionPolicy() {
  return {
    enforceNewEntryGate: process.env.TEG_UNATTENDED_PAPER_ENABLED === "true",
    heartbeatTimeoutMs: positiveEnv("TEG_SUPERVISOR_HEARTBEAT_TIMEOUT_MS") ?? 5_000,
    maxFutureSkewMs: positiveEnv("TEG_SUPERVISOR_MAX_FUTURE_SKEW_MS") ?? 1_000,
  };
}

function publicRuntimeConfigs() {
  if (process.env.TEG_PUBLIC_MARKET_DATA_ENABLED !== "true") return [];
  const configs = [];
  const upbit = process.env.TEG_UPBIT_PUBLIC_SYMBOL?.trim();
  const bitget = process.env.TEG_BITGET_PUBLIC_SYMBOL?.trim();
  if (upbit) configs.push({ provider: "upbit", market: "CRYPTO_SPOT", symbol: upbit });
  if (bitget) configs.push({ provider: "bitget", market: "CRYPTO_FUTURES", symbol: bitget });
  if (configs.length === 0) {
    throw new GatewayError("PUBLIC_MARKET_DATA_CONFIG_REQUIRED", "explicit public market-data enable requires at least one public symbol", 503);
  }
  if (typeof globalThis.WebSocket !== "function") {
    throw new GatewayError("PUBLIC_WEBSOCKET_RUNTIME_UNAVAILABLE", "explicit public WebSocket runtime requires a WebSocket-capable Node runtime", 503);
  }
  return configs;
}

const stateStore = new FilePaperStateStore(DEFAULT_STATE_PATH);
const protectionStore = new FileServerFailureProtectionStore(DEFAULT_PROTECTION_STATE_PATH);
const capitalStore = new FilePaperCapitalStateStore(DEFAULT_CAPITAL_STATE_PATH);
const initialPaperState = await stateStore.load();
const initialProtectionState = await protectionStore.load();
const initialCapitalState = await capitalStore.load();

const baseGateway = new TradeExecutionGateway({
  adapter: new PaperMockBrokerAdapter(),
  policy: buildPaperPolicy(),
  initialPaperState,
  persistPaperState: (snapshot, reason) => stateStore.save(snapshot, reason),
});
const supervisedGateway = new SupervisedPaperGateway({
  gateway: baseGateway,
  initialProtectionState,
  persistProtectionState: (snapshot, reason) => protectionStore.save(snapshot, reason),
  supervisionPolicy: buildSupervisionPolicy(),
  providerCapabilities: PAPER_MOCK_PROTECTION_CAPABILITIES,
});
const capitalManager = new PaperCompoundingCapitalManager({
  initialState: initialCapitalState,
  persistState: (snapshot, reason) => capitalStore.save(snapshot, reason),
  admissionGateEnabled: process.env.TEG_PAPER_COMPOUNDING_CAPITAL_ENABLED === "true",
});
const gateway = new CapitalManagedPaperGateway({
  gateway: supervisedGateway,
  capitalManager,
});

const publicRuntime = new PublicMarketDataRuntimeRegistry({ configs: publicRuntimeConfigs() });
publicRuntime.startAll();

function sendJson(response, statusCode, body) {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(payload);
}

async function readJson(request) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new GatewayError("REQUEST_TOO_LARGE", "request body exceeds 16 KiB", 413);
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new GatewayError("INVALID_JSON", "request body must be valid JSON", 400); }
}

function routeOrderId(pathname, suffix = "") {
  const escapedSuffix = suffix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = pathname.match(new RegExp(`^/v1/(?:paper/)?orders/([^/]+)${escapedSuffix}$`));
  return match ? decodeURIComponent(match[1]) : null;
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${HOST}`);

    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "trade-execution-gateway",
        bind: `${HOST}:${boundedPort(process.env.TEG_PORT)}`,
        safety: gateway.getSafetyState(),
        persistence: stateStore.getHealth(),
        protectionPersistence: protectionStore.getHealth(),
        capitalPersistence: capitalStore.getHealth(),
        recovery: gateway.getRecoveryState(),
        serverFailureProtection: gateway.getProtectionHealth(),
        compoundingCapital: gateway.getCapitalHealth(),
        publicMarketData: publicRuntime.getHealth(),
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/contracts") {
      sendJson(response, 200, publicContract());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/execution/runtime/health") {
      sendJson(response, 200, publicRuntime.getHealth());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/protection/health") {
      sendJson(response, 200, gateway.getProtectionHealth());
      return;
    }
    if (request.method === "GET" && url.pathname === "/v1/capital/health") {
      sendJson(response, 200, gateway.getCapitalHealth());
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/protection/heartbeat") {
      sendJson(response, 200, gateway.recordSupervisorHeartbeat(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/capital/settlement") {
      if (process.env.TEG_PAPER_COMPOUNDING_SETTLEMENT_INGEST_ENABLED !== "true") {
        throw new GatewayError(
          "CAPITAL_SETTLEMENT_INGEST_DISABLED",
          "Paper compounding settlement ingestion is default-off",
          403,
        );
      }
      sendJson(response, 200, await gateway.applyCapitalSettlement(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/orders/preview") {
      sendJson(response, 200, await gateway.previewOrder(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspace/orders/preview") {
      sendJson(response, 200, await previewWorkspaceOrder(gateway, await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/coin/orders/preview") {
      sendJson(response, 200, await previewCoinPaperOrder(gateway, await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/execution/market-data/validate") {
      const body = await readJson(request);
      sendJson(response, 200, normalizePublicMarketDataEvidence(body.evidence, body.policy));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/execution/guards/preview") {
      sendJson(response, 200, assessExecutionGuards(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/execution/runtime/guards/preview") {
      const body = await readJson(request);
      const evidence = publicRuntime.getLatestEvidence(body.provider, body.symbol);
      if (!evidence) throw new GatewayError("ATTESTED_PUBLIC_MARKET_DATA_UNAVAILABLE", "fresh gateway-observed public market data is unavailable", 503);
      sendJson(response, 200, assessAttestedExecutionGuards({ intent: body.intent, evidence, policy: body.policy }));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/execution/costs/preview") {
      sendJson(response, 200, estimateExecutionCosts(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/execution/tca/preview") {
      sendJson(response, 200, analyzeExecutionQuality(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/parity/preview") {
      sendJson(response, 200, comparePaperLiveParity(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/reconciliation/order/preview") {
      sendJson(response, 200, reconcileOrderEvidence(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/plans/cancel-replace/preview") {
      sendJson(response, 200, buildCancelReplacePlan(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/plans/bracket/preview") {
      sendJson(response, 200, buildBracketPlan(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/plans/trailing/preview") {
      sendJson(response, 200, buildTrailingPlan(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/paper/orders") {
      sendJson(response, 201, await gateway.placeOrder(await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/workspace/paper/orders") {
      sendJson(response, 201, await placeWorkspacePaperOrder(gateway, await readJson(request)));
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/coin/paper/orders") {
      sendJson(response, 201, await placeCoinPaperOrder(gateway, await readJson(request)));
      return;
    }
    if (request.method === "GET") {
      const orderId = routeOrderId(url.pathname);
      if (orderId) {
        sendJson(response, 200, await gateway.getOrder(orderId));
        return;
      }
    }
    if (request.method === "POST") {
      const protectionReconciliationOrderId = routeOrderId(url.pathname, "/protection/reconciliation/preview");
      if (protectionReconciliationOrderId) {
        sendJson(response, 200, gateway.previewProtectionReconciliation(protectionReconciliationOrderId, await readJson(request)));
        return;
      }
      const protectionIntentOrderId = routeOrderId(url.pathname, "/protection/intent");
      if (protectionIntentOrderId) {
        const body = await readJson(request);
        sendJson(response, 201, await gateway.registerProtectionIntent(protectionIntentOrderId, {
          bracketPlan: body.bracketPlan,
          protectionIdempotencyKey: body.protectionIdempotencyKey,
          createdAt: new Date().toISOString(),
        }));
        return;
      }
      const protectionAckOrderId = routeOrderId(url.pathname, "/protection/ack");
      if (protectionAckOrderId) {
        sendJson(response, 200, await gateway.acknowledgeProtection(protectionAckOrderId, await readJson(request)));
        return;
      }
      const tcaOrderId = routeOrderId(url.pathname, "/tca/preview");
      if (tcaOrderId) {
        const body = await readJson(request);
        const order = await gateway.getOrder(tcaOrderId);
        sendJson(response, 200, analyzeExecutionQuality({ ...body, order }));
        return;
      }
      const fillOrderId = routeOrderId(url.pathname, "/fill");
      if (fillOrderId) {
        sendJson(response, 200, await gateway.applyPaperFill(fillOrderId, await readJson(request)));
        return;
      }
      const orderId = routeOrderId(url.pathname, "/cancel");
      if (orderId) {
        sendJson(response, 200, await gateway.cancelOrder(orderId));
        return;
      }
    }
    sendJson(response, 404, { error: "NOT_FOUND" });
  } catch (error) {
    if (error instanceof GatewayError) {
      sendJson(response, error.statusCode, { error: error.code, message: error.message });
      return;
    }
    sendJson(response, 500, { error: "INTERNAL_ERROR" });
  }
});

const port = boundedPort(process.env.TEG_PORT);
server.listen(port, HOST, () => {
  console.log(`trade-execution-gateway listening on http://${HOST}:${port}`);
});

function shutdown() {
  publicRuntime.stopAll();
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);