import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PaperCompoundingCapitalManager } from "../src/paper-capital-manager.mjs";
import { FilePaperCapitalStateStore } from "../src/paper-capital-state-store.mjs";
import { FilePaperStateStore } from "../src/paper-state-store.mjs";
import { FileServerFailureProtectionStore } from "../src/server-failure-protection-store.mjs";

test("all durable Paper stores persist atomically on the current platform", async () => {
  const dir = await mkdtemp(join(tmpdir(), "teg-durable-platform-"));
  try {
    const paper = new FilePaperStateStore(join(dir, "paper.json"));
    await paper.save(await paper.load(), "PLATFORM_TEST");

    const capital = new FilePaperCapitalStateStore(join(dir, "capital.json"));
    await capital.load();
    await capital.save(new PaperCompoundingCapitalManager().exportState(), "PLATFORM_TEST");

    const protection = new FileServerFailureProtectionStore(join(dir, "protection.json"));
    await protection.save(await protection.load(), "PLATFORM_TEST");

    const expectedDirectoryFsync = process.platform !== "win32";
    for (const health of [paper.getHealth(), capital.getHealth(), protection.getHealth()]) {
      assert.equal(health.atomicRename, true);
      assert.equal(health.fileFsyncBeforeRename, true);
      assert.equal(health.directoryFsyncAfterRename, expectedDirectoryFsync);
      assert.equal(health.directoryFsyncRequiredWhenSupported, true);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
