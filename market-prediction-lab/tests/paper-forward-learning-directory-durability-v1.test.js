import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("Paper learning atomic publication persists its directory-entry boundary", async () => {
  const source = await readFile(
    new URL("../src/paper-forward-persistent-learning-store-v1.js", import.meta.url),
    "utf8",
  );

  assert.match(source, /async function syncDirectory\(path\)[\s\S]*await handle\.sync\(\);/u);
  assert.match(
    source,
    /await removeTemp\(tempPath\);[\s\S]*await syncDirectory\(root\);/u,
    "canonical link publication and temp unlink must be followed by a directory fsync",
  );
});
