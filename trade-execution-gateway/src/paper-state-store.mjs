import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const MODE = "PAPER_ONLY";
const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_ORDERS = 10_000;

export class PaperStateStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaperStateStoreError";
    this.code = code;
  }
}

function emptySnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: MODE,
    orders: [],
    idempotency: [],
    revision: 0,
  };
}

function requireObject(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PaperStateStoreError(code, message);
  }
  return value;
}

function validateSnapshot(snapshot) {
  requireObject(snapshot, "PAPER_STATE_INVALID", "paper state snapshot must be an object");
  if (snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.mode !== MODE) {
    throw new PaperStateStoreError("PAPER_STATE_SCHEMA_MISMATCH", "paper state schema or mode is unsupported");
  }
  if (!Array.isArray(snapshot.orders) || snapshot.orders.length > MAX_ORDERS) {
    throw new PaperStateStoreError("PAPER_STATE_ORDER_LIMIT", "paper state orders are invalid or exceed the safety cap");
  }
  if (!Array.isArray(snapshot.idempotency) || snapshot.idempotency.length > MAX_ORDERS) {
    throw new PaperStateStoreError("PAPER_STATE_IDEMPOTENCY_LIMIT", "paper idempotency state is invalid or exceeds the safety cap");
  }

  const orderIds = new Set();
  const keyByOrderId = new Map();
  for (const order of snapshot.orders) {
    requireObject(order, "PAPER_STATE_ORDER_INVALID", "paper state order must be an object");
    if (typeof order.orderId !== "string" || !order.orderId || orderIds.has(order.orderId)) {
      throw new PaperStateStoreError("PAPER_STATE_ORDER_ID_INVALID", "paper order ids must be unique non-empty strings");
    }
    if (
      order.simulated !== true ||
      order.realOrderSubmitted !== false ||
      order.privateTradingRequestSent !== false ||
      String(order.intent?.mode ?? "").toUpperCase() !== "PAPER"
    ) {
      throw new PaperStateStoreError("UNSAFE_PAPER_STATE_REJECTED", "durable state may contain PAPER-only simulated orders only");
    }
    const key = order.intent?.idempotencyKey;
    if (typeof key !== "string" || !key) {
      throw new PaperStateStoreError("PAPER_STATE_IDEMPOTENCY_MISSING", "every paper order requires an idempotency key");
    }
    orderIds.add(order.orderId);
    keyByOrderId.set(order.orderId, key);
  }

  const seenKeys = new Set();
  const mappedOrders = new Set();
  for (const entry of snapshot.idempotency) {
    if (!Array.isArray(entry) || entry.length !== 2) {
      throw new PaperStateStoreError("PAPER_STATE_IDEMPOTENCY_INVALID", "idempotency entries must be [key, orderId]");
    }
    const [key, orderId] = entry;
    if (typeof key !== "string" || !key || typeof orderId !== "string" || !orderIds.has(orderId)) {
      throw new PaperStateStoreError("PAPER_STATE_IDEMPOTENCY_INVALID", "idempotency entry references an unknown order");
    }
    if (seenKeys.has(key) || mappedOrders.has(orderId) || keyByOrderId.get(orderId) !== key) {
      throw new PaperStateStoreError("PAPER_STATE_IDEMPOTENCY_CONFLICT", "idempotency state is inconsistent");
    }
    seenKeys.add(key);
    mappedOrders.add(orderId);
  }
  if (mappedOrders.size !== orderIds.size) {
    throw new PaperStateStoreError("PAPER_STATE_IDEMPOTENCY_INCOMPLETE", "every restored order must have durable idempotency mapping");
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    mode: MODE,
    orders: structuredClone(snapshot.orders),
    idempotency: structuredClone(snapshot.idempotency),
    revision: Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0,
  };
}

function payloadForChecksum(document) {
  return {
    schemaVersion: document.schemaVersion,
    mode: document.mode,
    revision: document.revision,
    savedAt: document.savedAt,
    reason: document.reason,
    orders: document.orders,
    idempotency: document.idempotency,
  };
}

function checksum(document) {
  return createHash("sha256").update(JSON.stringify(payloadForChecksum(document))).digest("hex");
}

export class FilePaperStateStore {
  #filePath;
  #revision = 0;
  #loaded = false;
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new PaperStateStoreError("PAPER_STATE_PATH_REQUIRED", "paper state file path is required");
    }
    this.#filePath = resolve(filePath);
  }

  async load() {
    let raw;
    try {
      const metadata = await stat(this.#filePath);
      if (metadata.size > MAX_STATE_BYTES) {
        throw new PaperStateStoreError("PAPER_STATE_TOO_LARGE", "paper state file exceeds 5 MiB safety limit");
      }
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#loaded = true;
        this.#revision = 0;
        return emptySnapshot();
      }
      throw error;
    }

    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new PaperStateStoreError("PAPER_STATE_INVALID_JSON", "paper state file is not valid JSON");
    }
    requireObject(document, "PAPER_STATE_INVALID", "paper state document must be an object");
    if (typeof document.checksum !== "string" || document.checksum !== checksum(document)) {
      throw new PaperStateStoreError("PAPER_STATE_CHECKSUM_MISMATCH", "paper state integrity checksum mismatch");
    }
    const snapshot = validateSnapshot(document);
    this.#revision = snapshot.revision;
    this.#loaded = true;
    return snapshot;
  }

  async save(snapshot, reason = "PAPER_OMS_MUTATION") {
    const task = this.#writeQueue.then(() => this.#saveNow(snapshot, reason));
    this.#writeQueue = task.catch(() => undefined);
    return task;
  }

  async #saveNow(snapshot, reason) {
    const safe = validateSnapshot(snapshot);
    const safeReason = typeof reason === "string" && reason.length <= 80 ? reason : "PAPER_OMS_MUTATION";
    const document = {
      schemaVersion: SCHEMA_VERSION,
      mode: MODE,
      revision: this.#revision + 1,
      savedAt: new Date().toISOString(),
      reason: safeReason,
      orders: safe.orders,
      idempotency: safe.idempotency,
    };
    const withChecksum = { ...document, checksum: checksum(document) };
    const serialized = `${JSON.stringify(withChecksum, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new PaperStateStoreError("PAPER_STATE_TOO_LARGE", "serialized paper state exceeds 5 MiB safety limit");
    }

    await mkdir(dirname(this.#filePath), { recursive: true, mode: 0o700 });
    const tempPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${this.#filePath}.bak`;
    await writeFile(tempPath, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(tempPath, 0o600);
    try {
      await copyFile(this.#filePath, backupPath);
      await chmod(backupPath, 0o600);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rename(tempPath, this.#filePath);
    await chmod(this.#filePath, 0o600);
    this.#revision = document.revision;
    this.#loaded = true;
    return this.getHealth();
  }

  getHealth() {
    return Object.freeze({
      mode: MODE,
      schemaVersion: SCHEMA_VERSION,
      revision: this.#revision,
      loaded: this.#loaded,
      durableLocalFile: true,
      atomicRename: true,
      integrityChecksum: "SHA256",
      previousSnapshotBackup: true,
      productionDatabaseUsed: false,
      secretsAccepted: false,
      statePathExposed: false,
    });
  }
}
