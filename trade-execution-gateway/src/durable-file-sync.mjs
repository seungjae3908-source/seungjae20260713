import { open } from "node:fs/promises";

const WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED = new Set(["EACCES", "EISDIR", "EINVAL", "ENOTSUP", "EPERM"]);

export async function fsyncDirectoryAfterRename(directoryPath) {
  let handle;
  try {
    handle = await open(directoryPath, "r");
    await handle.sync();
    return true;
  } catch (error) {
    // Windows cannot open/fsync a directory through Node's file-handle API.
    // The state file is still fsynced before its atomic rename; only the
    // additional parent-directory durability barrier is unavailable there.
    if (process.platform === "win32" && WINDOWS_DIRECTORY_FSYNC_UNSUPPORTED.has(error?.code)) return false;
    throw error;
  } finally {
    if (handle) await handle.close();
  }
}

export function directoryFsyncSupported() {
  return process.platform !== "win32";
}
