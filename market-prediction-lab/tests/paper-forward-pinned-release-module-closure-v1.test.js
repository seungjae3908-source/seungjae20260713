import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceLab = resolve(testDirectory, "..");

async function withIsolatedRelease(run) {
  const root = await mkdtemp(join(tmpdir(), "paper-forward-pinned-release-"));
  const release = join(root, "market-prediction-lab");
  try {
    await cp(sourceLab, release, {
      recursive: true,
      filter(source) {
        const normalized = source.replaceAll("\\", "/");
        return !normalized.includes("/node_modules/")
          && !normalized.endsWith("/node_modules");
      },
    });
    return await run(release);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("pinned Paper release closes the complete startup module graph without workspace node_modules", async () => {
  await withIsolatedRelease(async (release) => {
    const runner = join(release, "scripts", "run-paper-forward-schedule.js");
    const result = spawnSync(process.execPath, [runner], {
      cwd: release,
      env: {
        ...process.env,
        PAPER_FORWARD_SCHEDULE_ACTIVE: "false",
        LIVE_TRADING: "false",
        LIVE_TRADING_ENABLED: "false",
        REAL_ORDER_ENABLED: "false",
        PRIVATE_API_ENABLED: "false",
        PRIVATE_ACCOUNT_ACCESS: "false",
        PRIVATE_TRADING_API_ALLOWED: "false",
      },
      encoding: "utf8",
      timeout: 30_000,
    });

    const stderr = String(result.stderr ?? "");
    assert.equal(result.signal, null, `isolated runner terminated by signal: ${result.signal}`);
    assert.equal(
      stderr.includes("ERR_MODULE_NOT_FOUND"),
      false,
      `isolated pinned release has an unresolved startup module:\n${stderr}`,
    );
    assert.equal(
      result.status,
      64,
      `isolated runner should reach the fail-closed inactive-schedule gate; status=${result.status}\nstderr=${stderr}`,
    );
  });
});
