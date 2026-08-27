import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

test("PR exact-head executes the standalone trade execution gateway suite", () => {
  const gatewayDir = resolve(process.cwd(), "trade-execution-gateway");
  assert.equal(existsSync(resolve(gatewayDir, "package.json")), true, "trade-execution-gateway package.json must exist");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["test"], {
    cwd: gatewayDir,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, TEG_PUBLIC_MARKET_DATA_ENABLED: "false" },
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  assert.equal(result.signal, null, `standalone gateway tests terminated by signal ${result.signal}`);
  assert.equal(result.status, 0, `standalone gateway tests failed with status ${result.status}`);
});
