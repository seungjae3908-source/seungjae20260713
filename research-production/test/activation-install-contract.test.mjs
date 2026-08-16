import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const scriptPath = resolve(here, "../deploy/activate-server.sh");

async function source() {
  return readFile(scriptPath, "utf8");
}

test("activation rebuilds an incomplete exact-SHA release instead of trusting directory existence", async () => {
  const text = await source();
  assert.match(text, /validate_release\(\)/);
  assert.match(text, /Removing incomplete isolated Research release for exact target SHA/);
  assert.match(text, /RELEASE_TMP="\$RELEASES\/\.\$\{TARGET_SHA\}\.tmp\.\$\$"/);
  assert.match(text, /validate_release "\$RELEASE_TMP"/);
  assert.match(text, /mv -T "\$RELEASE_TMP" "\$RELEASE"/);
  assert.match(text, /validate_release "\$RELEASE"/);
});

test("release content and exact git SHA are verified before current symlink cutover", async () => {
  const text = await source();
  const preflightIndex = text.indexOf('node "$RELEASE/research-production/bin/research-cycle.mjs" preflight');
  const switchIndex = text.indexOf('ln -sfn "$RELEASE" "$ROOT/current.new"');
  assert.ok(preflightIndex >= 0, "release-scoped preflight must exist");
  assert.ok(switchIndex >= 0, "atomic current symlink switch must exist");
  assert.ok(preflightIndex < switchIndex, "preflight must run before current cutover");
  assert.match(text, /candidate_sha=.*git -C "\$candidate" rev-parse HEAD\^\{commit\}/s);
  assert.match(text, /\[\[ "\$candidate_sha" == "\$TARGET_SHA" \]\]/);
});

test("failed activation disables timers and rolls current back to a previously valid release", async () => {
  const text = await source();
  assert.match(text, /systemctl disable --now/);
  assert.match(text, /rollback_current \|\| true/);
  assert.match(text, /PREVIOUS_CURRENT/);
  assert.match(text, /current\.rollback/);
  assert.match(text, /CURRENT_SWITCHED=false/);
});

test("existing application SHA and all trading authorities remain immutable", async () => {
  const text = await source();
  assert.match(text, /APP_SHA_BEFORE="\$\(read_app_sha\)"/);
  assert.match(text, /\[\[ "\$app_sha_after" == "\$APP_SHA_BEFORE" \]\]/);
  assert.match(text, /LIVE_TRADING=false/);
  assert.match(text, /PRIVATE_API_ENABLED=false/);
  assert.match(text, /ORDER_AUTHORITY=false/);
  assert.match(text, /ORDER_SUBMISSION_ENABLED=false/);
});
