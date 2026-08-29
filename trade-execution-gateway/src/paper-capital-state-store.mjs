import { createHash, randomUUID } from "node:crypto";
import { chmod, copyFile, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { PaperCompoundingCapitalManager } from "./paper-capital-manager.mjs";

const FILE_SCHEMA_VERSION = 1;
const FILE_MODE = "PAPER_COMPOUNDING_CAPITAL_STATE_FILE";
const MAX_STATE_BYTES = 2 * 1024 * 1024;

export class PaperCapitalStateStoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PaperCapitalStateStoreError";
    this.code = code;
  }
}

function object(value, code, message) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new PaperCapitalStateStoreError(code, message);
  return value;
}

function validateState(snapshot) {
  try {
    return new PaperCompoundingCapitalManager({ initialState: snapshot }).exportState();
  } catch (error) {
    throw new PaperCapitalStateStoreError(error?.code ?? "CAPITAL_STATE_INVALID", error?.message ?? "capital state is invalid");
  }
}

function checksumPayload(document) {
  return {
    fileSchemaVersion: document.fileSchemaVersion,
    fileMode: document.fileMode,
    revision: document.revision,
    savedAt: document.savedAt,
    reason: document.reason,
    state: document.state,
  };
}

function checksum(document) {
  return createHash("sha256").update(JSON.stringify(checksumPayload(document))).digest("hex");
}

export class FilePaperCapitalStateStore {
  #filePath;
  #revision = 0;
  #loaded = false;
  #writeQueue = Promise.resolve();

  constructor(filePath) {
    if (typeof filePath !== "string" || !filePath.trim()) {
      throw new PaperCapitalStateStoreError("CAPITAL_STATE_PATH_REQUIRED", "capital state file path is required");
    }
    this.#filePath = resolve(filePath);
  }

  async load() {
    let raw;
    try {
      const metadata = await stat(this.#filePath);
      if (metadata.size > MAX_STATE_BYTES) throw new PaperCapitalStateStoreError("CAPITAL_STATE_TOO_LARGE", "capital state file exceeds 2 MiB safety limit");
      raw = await readFile(this.#filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        this.#loaded = true;
        this.#revision = 0;
        return null;
      }
      throw error;
    }
    let document;
    try { document = JSON.parse(raw); }
    catch { throw new PaperCapitalStateStoreError("CAPITAL_STATE_INVALID_JSON", "capital state file is not valid JSON"); }
    object(document, "CAPITAL_STATE_DOCUMENT_INVALID", "capital state document must be an object");
    if (document.fileSchemaVersion !== FILE_SCHEMA_VERSION || document.fileMode !== FILE_MODE) {
      throw new PaperCapitalStateStoreError("CAPITAL_STATE_FILE_SCHEMA_MISMATCH", "capital state file schema is unsupported");
    }
    if (typeof document.checksum !== "string" || document.checksum !== checksum(document)) {
      throw new PaperCapitalStateStoreError("CAPITAL_STATE_CHECKSUM_MISMATCH", "capital state checksum mismatch");
    }
    if (!Number.isInteger(document.revision) || document.revision < 0) {
      throw new PaperCapitalStateStoreError("CAPITAL_STATE_REVISION_INVALID", "capital state revision is invalid");
    }
    const state = validateState(document.state);
    this.#revision = document.revision;
    this.#loaded = true;
    return state;
  }

  async save(snapshot, reason = "PAPER_CAPITAL_MUTATION") {
    const task = this.#writeQueue.then(() => this.#saveNow(snapshot, reason));
    this.#writeQueue = task.catch(() => undefined);
    return task;
  }

  async #saveNow(snapshot, reason) {
    const state = validateState(snapshot);
    const safeReason = typeof reason === "string" && reason.length <= 96 ? reason : "PAPER_CAPITAL_MUTATION";
    const document = {
      fileSchemaVersion: FILE_SCHEMA_VERSION,
      fileMode: FILE_MODE,
      revision: this.#revision + 1,
      savedAt: new Date().toISOString(),
      reason: safeReason,
      state,
    };
    const withChecksum = { ...document, checksum: checksum(document) };
    const serialized = `${JSON.stringify(withChecksum, null, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) {
      throw new PaperCapitalStateStoreError("CAPITAL_STATE_TOO_LARGE", "serialized capital state exceeds 2 MiB safety limit");
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
      fileMode: FILE_MODE,
      fileSchemaVersion: FILE_SCHEMA_VERSION,
      revision: this.#revision,
      loaded: this.#loaded,
      durableLocalFile: true,
      atomicRename: true,
      fileFsyncBeforeRename: true,
      directoryFsyncAfterRename: true,
      integrityChecksum: "SHA256",
      previousSnapshotBackup: true,
      productionDatabaseUsed: false,
      secretsAccepted: false,
      externalWithdrawalPerformed: false,
      statePathExposed: false,
    });
  }
}
