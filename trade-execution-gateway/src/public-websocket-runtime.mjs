import { randomUUID } from "node:crypto";
import { normalizePublicMarketDataEvidence } from "./market-data-evidence.mjs";
import { ProviderHealthCircuit, ProviderHealthError } from "./provider-health.mjs";

const ENDPOINTS = Object.freeze({
  upbit: "wss://api.upbit.com/websocket/v1",
  bitget: "wss://ws.bitget.com/v2/ws/public",
});

export class PublicWebSocketRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PublicWebSocketRuntimeError";
    this.code = code;
  }
}

function requireText(value, name, max = 64) {
  if (typeof value !== "string") throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_RUNTIME_CONFIG", `${name} must be a string`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_RUNTIME_CONFIG", `${name} is invalid`);
  return normalized;
}

function positive(value, code = "INVALID_PUBLIC_RUNTIME_MESSAGE") {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new PublicWebSocketRuntimeError(code, "positive numeric value required");
  return number;
}

function sequence(value, name) {
  try { return BigInt(String(value)); } catch { throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_SEQUENCE", `${name} must be an integer sequence`); }
}

function depthMap(levels) {
  const map = new Map();
  if (!Array.isArray(levels)) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "depth payload must be an array");
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "depth level must contain price and size");
    const price = positive(level[0], "INVALID_PUBLIC_DEPTH");
    const size = Number(level[1]);
    if (!Number.isFinite(size) || size < 0) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "depth size must be non-negative");
    if (size === 0) map.delete(price); else map.set(price, size);
  }
  return map;
}

function applyDepthDelta(map, levels) {
  if (!Array.isArray(levels)) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "depth delta must be an array");
  for (const level of levels) {
    if (!Array.isArray(level) || level.length < 2) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "depth delta level must contain price and size");
    const price = positive(level[0], "INVALID_PUBLIC_DEPTH");
    const size = Number(level[1]);
    if (!Number.isFinite(size) || size < 0) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "depth delta size must be non-negative");
    if (size === 0) map.delete(price); else map.set(price, size);
  }
}

function sortedDepth(map, side) {
  const entries = [...map.entries()].map(([price, size]) => ({ price, size }));
  entries.sort((left, right) => side === "bids" ? right.price - left.price : left.price - right.price);
  return entries.slice(0, 50);
}

async function messageText(data) {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  if (data && typeof data.text === "function") return data.text();
  throw new PublicWebSocketRuntimeError("PUBLIC_MESSAGE_ENCODING_UNSUPPORTED", "WebSocket message encoding is unsupported");
}

function addListener(socket, event, handler) {
  if (typeof socket.addEventListener === "function") socket.addEventListener(event, handler);
  else if (typeof socket.on === "function") socket.on(event, handler);
  else throw new PublicWebSocketRuntimeError("PUBLIC_WEBSOCKET_INTERFACE_INVALID", "WebSocket implementation lacks event listeners");
}

function defaultWebSocketFactory(url) {
  if (typeof globalThis.WebSocket !== "function") {
    throw new PublicWebSocketRuntimeError("PUBLIC_WEBSOCKET_RUNTIME_UNAVAILABLE", "public WebSocket runtime requires a standards-compatible global WebSocket implementation");
  }
  return new globalThis.WebSocket(url);
}

function rejectCredentials(config) {
  for (const field of ["headers", "authorization", "apiKey", "apiSecret", "secret", "passphrase", "token", "jwt"]) {
    if (config?.[field] != null) throw new PublicWebSocketRuntimeError("PUBLIC_RUNTIME_CREDENTIALS_REJECTED", `${field} is forbidden for public market-data runtime`);
  }
}

function subscription(provider, symbol) {
  if (provider === "upbit") {
    return [
      { ticket: `teg-${randomUUID()}` },
      { type: "orderbook", codes: [symbol] },
      { type: "trade", codes: [symbol] },
      { format: "DEFAULT" },
    ];
  }
  return {
    op: "subscribe",
    args: [
      { instType: "usdt-futures", topic: "books", symbol },
      { instType: "usdt-futures", topic: "publicTrade", symbol },
    ],
  };
}

export class PublicMarketDataWebSocketRuntime {
  #provider;
  #market;
  #symbol;
  #endpoint;
  #factory;
  #now;
  #setTimeout;
  #clearTimeout;
  #health;
  #socket = null;
  #reconnectTimer = null;
  #heartbeatTimer = null;
  #stopped = true;
  #connectionEpoch = 0;
  #latestEvidence = null;
  #book = null;
  #trade = null;
  #lastUpbitTradeSequence = null;
  #lastBitgetBookSequence = null;
  #bitgetAwaitingFirstUpdate = false;

  constructor({ provider, market, symbol, webSocketFactory = defaultWebSocketFactory, now = () => Date.now(), setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, healthPolicy = {}, ...rest } = {}) {
    rejectCredentials(rest);
    this.#provider = requireText(provider, "provider", 32).toLowerCase();
    if (!ENDPOINTS[this.#provider]) throw new PublicWebSocketRuntimeError("PUBLIC_PROVIDER_UNSUPPORTED", "only Upbit and Bitget public market data are supported in v0.5");
    this.#market = requireText(market, "market", 32).toUpperCase();
    this.#symbol = requireText(symbol, "symbol", 64).toUpperCase();
    if (this.#provider === "upbit" && this.#market !== "CRYPTO_SPOT") throw new PublicWebSocketRuntimeError("PUBLIC_PROVIDER_MARKET_MISMATCH", "Upbit v0.5 runtime is CRYPTO_SPOT only");
    if (this.#provider === "bitget" && this.#market !== "CRYPTO_FUTURES") throw new PublicWebSocketRuntimeError("PUBLIC_PROVIDER_MARKET_MISMATCH", "Bitget v0.5 runtime is CRYPTO_FUTURES only");
    this.#endpoint = ENDPOINTS[this.#provider];
    this.#factory = webSocketFactory;
    this.#now = now;
    this.#setTimeout = setTimeoutFn;
    this.#clearTimeout = clearTimeoutFn;
    this.#health = new ProviderHealthCircuit({ provider: this.#provider, minConnectIntervalMs: 2_000, ...healthPolicy });
  }

  start() {
    if (!this.#stopped) return;
    this.#stopped = false;
    this.#connect();
  }

  stop() {
    this.#stopped = true;
    this.#clearScheduledTimers();
    const socket = this.#socket;
    this.#socket = null;
    if (socket && typeof socket.close === "function") {
      try { socket.close(); } catch { /* no-op */ }
    }
  }

  #clearScheduledTimers() {
    if (this.#reconnectTimer !== null) {
      this.#clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    if (this.#heartbeatTimer !== null) {
      this.#clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
  }

  #connect() {
    if (this.#stopped) return;
    const nowMs = this.#now();
    try {
      this.#health.beforeConnect(nowMs);
      this.#connectionEpoch += 1;
      this.#book = null;
      this.#trade = null;
      this.#lastUpbitTradeSequence = null;
      this.#lastBitgetBookSequence = null;
      this.#bitgetAwaitingFirstUpdate = false;
      this.#latestEvidence = null;
      const socket = this.#factory(this.#endpoint);
      this.#socket = socket;
      addListener(socket, "open", () => this.#onOpen(socket));
      addListener(socket, "message", (event) => this.#onMessage(event?.data ?? event));
      addListener(socket, "error", () => this.#onFailure("PUBLIC_WEBSOCKET_ERROR"));
      addListener(socket, "close", () => this.#onClose());
    } catch (error) {
      const code = error?.code ?? "PUBLIC_WEBSOCKET_CONNECT_FAILED";
      if (!(error instanceof ProviderHealthError && code === "PROVIDER_CONNECT_RATE_LIMIT")) this.#health.recordFailure(code, nowMs);
      this.#scheduleReconnect();
    }
  }

  #onOpen(socket) {
    if (this.#stopped || socket !== this.#socket) return;
    this.#health.recordConnected(this.#now());
    socket.send(JSON.stringify(subscription(this.#provider, this.#symbol)));
    this.#scheduleHeartbeat(socket);
  }

  #scheduleHeartbeat(socket) {
    if (this.#stopped || socket !== this.#socket || this.#heartbeatTimer !== null) return;
    this.#heartbeatTimer = this.#setTimeout(() => {
      this.#heartbeatTimer = null;
      if (this.#stopped || socket !== this.#socket) return;
      try {
        socket.send(this.#provider === "bitget" ? "ping" : "PING");
        this.#scheduleHeartbeat(socket);
      } catch {
        this.#onFailure("PUBLIC_HEARTBEAT_SEND_FAILED");
      }
    }, this.#provider === "bitget" ? 25_000 : 60_000);
  }

  async #onMessage(data) {
    if (this.#stopped) return;
    try {
      const text = await messageText(data);
      if (text === "pong") return;
      const parsed = JSON.parse(text);
      if (parsed?.status === "UP") return;
      if (this.#provider === "upbit") this.#onUpbit(parsed);
      else this.#onBitget(parsed);
    } catch (error) {
      const code = error?.code ?? "PUBLIC_MESSAGE_INVALID";
      this.#health.recordFailure(code, this.#now());
      const state = this.#health.snapshot(this.#now());
      if (
        ["BITGET_SEQUENCE_GAP", "BITGET_SEQUENCE_REGRESSION", "BITGET_SEQUENCE_RESET", "PROVIDER_CLOCK_SKEW_EXCEEDED", "UPBIT_ORDERBOOK_TIME_REGRESSION"].includes(code) ||
        state.circuitState === "OPEN"
      ) {
        this.#forceReconnect(code);
      }
    }
  }

  #onUpbit(packet) {
    if (!packet || typeof packet !== "object") throw new PublicWebSocketRuntimeError("PUBLIC_MESSAGE_INVALID", "Upbit packet must be an object");
    const type = String(packet.type ?? "").toLowerCase();
    const symbol = String(packet.code ?? packet.market ?? "").toUpperCase();
    if (symbol !== this.#symbol) throw new PublicWebSocketRuntimeError("PUBLIC_SYMBOL_MISMATCH", "Upbit packet symbol mismatch");
    const timestamp = positive(packet.timestamp, "INVALID_PROVIDER_TIMESTAMP");
    this.#health.recordMessage(timestamp, this.#now());

    if (type === "orderbook") {
      const streamType = String(packet.stream_type ?? "").toUpperCase();
      if (!this.#book && streamType !== "SNAPSHOT") {
        this.#health.requireResync("UPBIT_INITIAL_SNAPSHOT_REQUIRED");
        throw new PublicWebSocketRuntimeError("UPBIT_INITIAL_SNAPSHOT_REQUIRED", "Upbit orderbook requires an initial snapshot after connect");
      }
      const units = packet.orderbook_units;
      if (!Array.isArray(units) || units.length === 0) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_DEPTH", "Upbit orderbook units are required");
      const asks = units.map((unit) => ({ price: positive(unit.ask_price, "INVALID_PUBLIC_DEPTH"), size: positive(unit.ask_size, "INVALID_PUBLIC_DEPTH") }));
      const bids = units.map((unit) => ({ price: positive(unit.bid_price, "INVALID_PUBLIC_DEPTH"), size: positive(unit.bid_size, "INVALID_PUBLIC_DEPTH") }));
      if (this.#book && timestamp < this.#book.timestamp) throw new PublicWebSocketRuntimeError("UPBIT_ORDERBOOK_TIME_REGRESSION", "Upbit orderbook timestamp regressed");
      this.#book = { asks, bids, timestamp, streamType };
      if (streamType === "SNAPSHOT") this.#health.clearResync();
    } else if (type === "trade") {
      const tradeSequence = sequence(packet.sequential_id, "sequential_id");
      const streamType = String(packet.stream_type ?? "").toUpperCase();
      if (streamType === "REALTIME" && this.#lastUpbitTradeSequence !== null && tradeSequence <= this.#lastUpbitTradeSequence) {
        throw new PublicWebSocketRuntimeError("UPBIT_TRADE_SEQUENCE_REGRESSION", "Upbit realtime trade sequence regressed");
      }
      this.#lastUpbitTradeSequence = tradeSequence;
      this.#trade = {
        price: positive(packet.trade_price, "INVALID_PUBLIC_TRADE_PRICE"),
        timestamp: positive(packet.trade_timestamp ?? packet.timestamp, "INVALID_PROVIDER_TIMESTAMP"),
        sequence: tradeSequence.toString(),
      };
    }
    this.#attestIfReady();
  }

  #onBitget(packet) {
    if (!packet || typeof packet !== "object") throw new PublicWebSocketRuntimeError("PUBLIC_MESSAGE_INVALID", "Bitget packet must be an object");
    if (packet.event) {
      if (packet.event === "error") throw new PublicWebSocketRuntimeError("BITGET_SUBSCRIPTION_ERROR", String(packet.msg ?? "Bitget subscription error"));
      return;
    }
    const arg = packet.arg ?? {};
    const topic = String(arg.topic ?? arg.channel ?? "");
    const symbol = String(arg.symbol ?? arg.instId ?? "").toUpperCase();
    if (symbol !== this.#symbol) throw new PublicWebSocketRuntimeError("PUBLIC_SYMBOL_MISMATCH", "Bitget packet symbol mismatch");
    const data = Array.isArray(packet.data) ? packet.data : [];
    if (data.length === 0) return;

    if (topic === "books") {
      const row = data[0];
      const action = String(packet.action ?? "").toLowerCase();
      const seq = sequence(row.seq, "seq");
      const timestamp = positive(row.ts ?? packet.ts, "INVALID_PROVIDER_TIMESTAMP");
      this.#health.recordMessage(timestamp, this.#now());
      if (action === "snapshot") {
        this.#book = { asksMap: depthMap(row.a ?? row.asks), bidsMap: depthMap(row.b ?? row.bids), timestamp };
        this.#lastBitgetBookSequence = seq;
        this.#bitgetAwaitingFirstUpdate = true;
        this.#health.clearResync();
      } else if (action === "update") {
        if (!this.#book || this.#lastBitgetBookSequence === null) {
          this.#health.requireResync("BITGET_SNAPSHOT_REQUIRED");
          throw new PublicWebSocketRuntimeError("BITGET_SEQUENCE_GAP", "Bitget update arrived before snapshot");
        }
        const pseq = sequence(row.pseq, "pseq");
        if (pseq === 0n) {
          this.#health.requireResync("BITGET_SEQUENCE_RESET");
          throw new PublicWebSocketRuntimeError("BITGET_SEQUENCE_RESET", "Bitget sequence reset requires a fresh snapshot");
        }
        if (this.#bitgetAwaitingFirstUpdate) {
          if (!(pseq <= this.#lastBitgetBookSequence && this.#lastBitgetBookSequence <= seq)) {
            this.#health.requireResync("BITGET_SEQUENCE_GAP");
            throw new PublicWebSocketRuntimeError("BITGET_SEQUENCE_GAP", "Bitget snapshot seq is outside the first update [pseq, seq] range");
          }
          this.#bitgetAwaitingFirstUpdate = false;
        } else {
          if (pseq !== this.#lastBitgetBookSequence) {
            this.#health.requireResync("BITGET_SEQUENCE_GAP");
            throw new PublicWebSocketRuntimeError("BITGET_SEQUENCE_GAP", "Bitget pseq does not match the previous update seq");
          }
          if (seq <= this.#lastBitgetBookSequence) {
            this.#health.requireResync("BITGET_SEQUENCE_REGRESSION");
            throw new PublicWebSocketRuntimeError("BITGET_SEQUENCE_REGRESSION", "Bitget seq must increase");
          }
        }
        applyDepthDelta(this.#book.asksMap, row.a ?? row.asks ?? []);
        applyDepthDelta(this.#book.bidsMap, row.b ?? row.bids ?? []);
        this.#book.timestamp = timestamp;
        this.#lastBitgetBookSequence = seq;
      }
    } else if (topic === "publicTrade" || topic === "trade") {
      const row = data[data.length - 1];
      if (!row || typeof row !== "object" || Array.isArray(row)) throw new PublicWebSocketRuntimeError("INVALID_PUBLIC_TRADE", "Bitget public trade row must be an object");
      const timestamp = positive(row.T ?? packet.ts, "INVALID_PROVIDER_TIMESTAMP");
      this.#health.recordMessage(timestamp, this.#now());
      this.#trade = {
        price: positive(row.p, "INVALID_PUBLIC_TRADE_PRICE"),
        timestamp,
        sequence: String(row.i ?? row.L ?? timestamp),
      };
    }
    this.#attestIfReady();
  }

  #attestIfReady() {
    if (!this.#book || !this.#trade || this.#health.snapshot(this.#now()).resyncRequired) return;
    const asks = this.#provider === "upbit" ? this.#book.asks : sortedDepth(this.#book.asksMap, "asks");
    const bids = this.#provider === "upbit" ? this.#book.bids : sortedDepth(this.#book.bidsMap, "bids");
    if (asks.length === 0 || bids.length === 0) return;
    const nowMs = this.#now();
    const normalized = normalizePublicMarketDataEvidence({
      market: this.#market,
      provider: this.#provider,
      source: this.#provider === "upbit" ? "UPBIT_PUBLIC_WEBSOCKET" : "BITGET_PUBLIC_WEBSOCKET",
      symbol: this.#symbol,
      quoteObservedAt: this.#book.timestamp,
      tradeObservedAt: this.#trade.timestamp,
      lastTradePrice: this.#trade.price,
      asks,
      bids,
      providerSequence: this.#provider === "bitget" ? this.#lastBitgetBookSequence?.toString() : this.#trade.sequence,
    }, {
      maxQuoteAgeMs: 5_000,
      maxTradeAgeMs: 5_000,
      maxFutureSkewMs: 5_000,
      requireTrade: true,
      nowMs,
    });
    this.#latestEvidence = Object.freeze({
      ...normalized,
      authority: "GATEWAY_TRANSPORT_OBSERVED_PUBLIC_EVIDENCE",
      callerSuppliedEvidence: false,
      serverAttested: true,
      transportObservedByGateway: true,
      paperDecisionSupportEligible: true,
      liveExecutionEligible: false,
      outboundNetworkPerformed: true,
      privateApiUsed: false,
      transport: Object.freeze({
        endpoint: this.#endpoint,
        connectionEpoch: this.#connectionEpoch,
        gatewayObservedAt: new Date(nowMs).toISOString(),
        authenticated: false,
        privateChannel: false,
      }),
    });
  }

  #onFailure(code) {
    this.#health.recordFailure(code, this.#now());
    this.#forceReconnect(code);
  }

  #onClose() {
    if (this.#stopped) return;
    this.#socket = null;
    if (this.#heartbeatTimer !== null) {
      this.#clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    this.#health.recordDisconnected();
    this.#scheduleReconnect();
  }

  #forceReconnect(code) {
    this.#latestEvidence = null;
    this.#health.requireResync(code);
    const socket = this.#socket;
    this.#socket = null;
    if (this.#heartbeatTimer !== null) {
      this.#clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    if (socket && typeof socket.close === "function") {
      try { socket.close(); } catch { /* no-op */ }
    }
    this.#scheduleReconnect();
  }

  #scheduleReconnect() {
    if (this.#stopped || this.#reconnectTimer !== null) return;
    const delay = this.#health.nextReconnectDelayMs(this.#now());
    this.#reconnectTimer = this.#setTimeout(() => {
      this.#reconnectTimer = null;
      this.#connect();
    }, delay);
  }

  getLatestEvidence() {
    return this.#latestEvidence;
  }

  getHealth() {
    return Object.freeze({
      ...this.#health.snapshot(this.#now()),
      market: this.#market,
      symbol: this.#symbol,
      endpoint: this.#endpoint,
      publicOnly: true,
      credentialsAccepted: false,
      heartbeat: this.#provider === "bitget" ? "TEXT_PING_25S" : "TEXT_PING_60S",
      actualPrivateWebSocketConnected: false,
      serverAttestedEvidenceAvailable: this.#latestEvidence?.serverAttested === true,
      liveExecutionEligible: false,
    });
  }
}

export class PublicMarketDataRuntimeRegistry {
  #runtimes = new Map();

  constructor({ configs = [], webSocketFactory, now, setTimeoutFn, clearTimeoutFn } = {}) {
    for (const config of configs) {
      const runtime = new PublicMarketDataWebSocketRuntime({
        ...config,
        ...(webSocketFactory ? { webSocketFactory } : {}),
        ...(now ? { now } : {}),
        ...(setTimeoutFn ? { setTimeoutFn } : {}),
        ...(clearTimeoutFn ? { clearTimeoutFn } : {}),
      });
      const key = `${String(config.provider).toLowerCase()}:${String(config.symbol).toUpperCase()}`;
      if (this.#runtimes.has(key)) throw new PublicWebSocketRuntimeError("DUPLICATE_PUBLIC_RUNTIME", `duplicate public runtime ${key}`);
      this.#runtimes.set(key, runtime);
    }
  }

  startAll() {
    for (const runtime of this.#runtimes.values()) runtime.start();
  }

  stopAll() {
    for (const runtime of this.#runtimes.values()) runtime.stop();
  }

  getLatestEvidence(provider, symbol) {
    return this.#runtimes.get(`${String(provider).toLowerCase()}:${String(symbol).toUpperCase()}`)?.getLatestEvidence() ?? null;
  }

  getHealth() {
    return Object.freeze({
      configuredRuntimes: this.#runtimes.size,
      actualPublicNetworkEnabled: this.#runtimes.size > 0,
      privateNetworkEnabled: false,
      liveExecutionEligible: false,
      providers: Object.freeze([...this.#runtimes.values()].map((runtime) => runtime.getHealth())),
    });
  }
}
