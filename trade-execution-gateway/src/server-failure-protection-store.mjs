import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SCHEMA_VERSION = 1;
const MODE = "PAPER_PROTECTION_ONLY";
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_PROTECTIONS = 10_000;

export class ProtectionStateStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProtectionStateStoreError";
    this.code = code;
  }
}

function emptySnapshot() {
  return { schemaVersion: SCHEMA_VERSION, mode: MODE, protections: [], revision: 0 };
}

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ProtectionStateStoreError(code, message);
  return value;
}

function validate(snapshot) {
  object(snapshot, "PROTECTION_STATE_INVALID", "protection state must be an object");
  if (snapshot.schemaVersion !== SCHEMA_VERSION || snapshot.mode !== MODE) {
    throw new ProtectionStateStoreError("PROTECTION_STATE_SCHEMA_MISMATCH", "protection state schema is unsupported");
  }
  if (!Array.isArray(snapshot.protections) || snapshot.protections.length > MAX_PROTECTIONS) {
    throw new ProtectionStateStoreError("PROTECTION_STATE_LIMIT", "protection records are invalid or exceed the safety cap");
  }
  const entryIds = new Set();
  const keys = new Set();
  for (const record of snapshot.protections) {
    object(record, "PROTECTION_STATE_RECORD_INVALID", "protection record must be an object");
    if (
      record.kind !== "ENTRY_PROTECTION_INTENT_V1"
      || typeof record.entryOrderId !== "string" || !record.entryOrderId
      || typeof record.protectionIdempotencyKey !== "string" || !record.protectionIdempotencyKey
    ) {
      throw new ProtectionStateStoreError("PROTECTION_STATE_RECORD_INVALID", "protection identity is invalid");
    }
    if (
      record.executionMode !== "PAPER_ONLY"
      || record.executionAuthority !== "NONE"
      || record.privateApiUsed !== false
      || record.realOrderSubmitted !== false
      || record.unattendedLiveEligible !== false
    ) {
      throw new ProtectionStateStoreError("UNSAFE_PROTECTION_STATE_REJECTED", "durable protection state may contain Paper-only evidence only");
    }
    if (entryIds.has(record.entryOrderId) || keys.has(record.protectionIdempotencyKey)) {
      throw new ProtectionStateStoreError("PROTECTION_STATE_IDEMPOTENCY_CONFLICT", "protection identities must be unique");
    }
    entryIds.add(record.entryOrderId);
    keys.add(record.protectionIdempotencyKey);
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    mode: MODE,
    protections: structuredClone(snapshot.protections),
    revision: Number.isInteger(snapshot.revision) && snapshot.revision >= 0 ? snapshot.revision : 0,
  };
}

function payload(document) {
  return {
    schemaVersion: document.schemaVersion,
    mode: document.mode,
    revision: document.revision,
    savedAt: document.savedAt,
    reason: document.reason,
    protections: document.protections,
  };
}

function checksum(document) {
  return createHash("sha256").update(JSON.stringify(payload(document))).digest("hex");
}

export class FileServerFailureProtectionStore {
  #filePath;
  #revision = 0;
  #loaded = false;
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new ProtectionStateStoreError("PROTECTION_STATE_PATH_REQUIRED", "protection state file path is required");
    }
    this.#filePath = resolve(filePath);
  }

  async load() {
    let raw;
    try {
      const metadata = await stat(this.#filePath);
      if (metadata.size > MAX_STATE_BYTES) {
        throw new ProtectionStateStoreError("PROTECTION_STATE_TOO_LARGE", "protection state file exceeds 2 MiB safety limit");
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
    try { document = JSON.parse(raw); }
    catch { throw new ProtectionStateStoreError("PROTECTION_STATE_INVALID_JSON", "protection state file is not valid JSON"); }
    object(document, "PROTECTION_STATE_INVALID", "protection state document must be an object");
    if (typeof document.checksum !== "string" || document.checksum !== checksum(document)) {
      throw new ProtectionStateStoreError("PROTECTION_STATE_CHECKSUM_MISMATCH", "protection state checksum mismatch");
    }
    const snapshot = validate(document);
    this.#revision = snapshot.revision;
    this.#loaded = true;
    return snapshot;
  }

  async save(snapshot, reason = "PROTECTION_STATE_MUTATION") {
    const task = this.#writeQueue.then(() => this.#saveNow(snapshot, reason));
    this.#writeQueue = task.catch(() => undefined);
    return task;
  }

  async #saveNow(snapshot, reason) {
    const safe = validate(snapshot);
    const safeReason = typeof reason === "string" && reason.length <= 96 ? reason : "PROTECTION_STATE_MUTATION";
    const document = {
      schemaVersion: SCHEMA_VERSION,
      mode: MODE,
      revision: this.#revision + 1,
      savedAt: new Date().toISOString(),
      reason: safeReason,
      protections: safe.protections,
    };
    const withChecksum = { ...document, checksum: checksum(document) };
    const serialized = `${JSON.stringify(withChecksum, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new ProtectionStateStoreError("PROTECTION_STATE_TOO_LARGE", "serialized protection state exceeds 2 MiB safety limit");
    }

    const stateDir = dirname(this.#filePath);
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    await chmod(stateDir, 0o700);
    const tempPath = `${this.#filePath}.${process.pid}.${randomUUID()}.tmp`;
    const backupPath = `${this.#filePath}.bak`;
    let renamed = false;
    try {
      const handle = await open(tempPath, "wx", 0o600);
      try {
        await handle.writeFile(serialized, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await chmod(tempPath, 0o600);
      try {
        await copyFile(this.#filePath, backupPath);
        await chmod(backupPath, 0o600);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
      await rename(tempPath, this.#filePath);
      renamed = true;
      await chmod(this.#filePath, 0o600);
      const directoryHandle = await open(stateDir, "r");
      try { await directoryHandle.sync(); }
      finally { await directoryHandle.close(); }
    } finally {
      if (!renamed) {
        try { await unlink(tempPath); }
        catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
    }
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
      fileFsyncBeforeRename: true,
      directoryFsyncAfterRename: true,
      integrityChecksum: "SHA256",
      previousSnapshotBackup: true,
      heartbeatPersisted: false,
      productionDatabaseUsed: false,
      secretsAccepted: false,
      statePathExposed: false,
    });
  }
}
