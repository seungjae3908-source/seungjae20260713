import http from "node:http";
import { publicContract } from "./contracts.mjs";
import {
  GatewayError,
  PaperMockBrokerAdapter,
  TradeExecutionGateway,
} from "./gateway.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 16 * 1024;
const MARKETS = ["KR_STOCK", "US_STOCK", "CRYPTO_SPOT", "CRYPTO_FUTURES"];

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

const gateway = new TradeExecutionGateway({
  adapter: new PaperMockBrokerAdapter(),
  policy: buildPaperPolicy(),
});

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
    if (bytes > MAX_BODY_BYTES) {
      throw new GatewayError("REQUEST_TOO_LARGE", "request body exceeds 16 KiB", 413);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new GatewayError("INVALID_JSON", "request body must be valid JSON", 400);
  }
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
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/v1/contracts") {
      sendJson(response, 200, publicContract());
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/orders/preview") {
      const body = await readJson(request);
      sendJson(response, 200, await gateway.previewOrder(body));
      return;
    }

    if (request.method === "POST" && url.pathname === "/v1/paper/orders") {
      const body = await readJson(request);
      sendJson(response, 201, await gateway.placeOrder(body));
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
  server.close(() => process.exit(0));
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
