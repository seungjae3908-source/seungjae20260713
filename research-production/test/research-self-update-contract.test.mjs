import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path) => readFileSync(new URL(`../deploy/${path}`, import.meta.url), 'utf8');
const script = read('self-update.sh');
const activate = read('activate-server.sh');

test('self-update script is valid bash and runs only as root under a lock', () => {
  execFileSync('bash', ['-n', new URL('../deploy/self-update.sh', import.meta.url).pathname]);
  assert.match(script, /SELF_UPDATE_ROOT_REQUIRED/);
  assert.match(script, /flock -n 9/);
  assert.match(script, /RESEARCH_SELF_UPDATE_ENABLED=\(false\|0\)/);
});

test('isolated validation runs before any production cutover', () => {
  const main = script.slice(script.indexOf('write_status VALIDATING'));
  const validate = main.indexOf('validate-isolated');
  const cutover = main.indexOf('activate-server.sh" activate');
  const ai = main.indexOf('activate-ai-research.sh" activate');
  assert.ok(validate > 0 && cutover > validate && ai > cutover);
  assert.match(script, /VALIDATION_FAILED.*running release unchanged/);
});

test('only Research path changes trigger an update; app-only merges are ignored', () => {
  assert.match(script, /RESEARCH_PATH_PREFIXES=\(research-production\/ market-prediction-lab\/ packages\/\)/);
  assert.match(script, /NO_RESEARCH_CHANGE/);
  assert.match(script, /WAITING_AFTER_FAILURE/);
  assert.match(script, /DEFERRED_MANUAL_ACTIVATION/);
});

test('self-update never touches the app, trading or member data', () => {
  for (const forbidden of [/\bpm2\b/i, /stock-app/, /psql/, /LIVE_TRADING=true/, /activate-production/, /trade-execution/]) {
    assert.doesNotMatch(script, forbidden, String(forbidden));
  }
  assert.match(script, /executionAuthority: "NONE"/);
  const unit = read('investment-research-self-update.service');
  assert.match(unit, /Environment=LIVE_TRADING=false/);
  assert.match(unit, /Environment=ORDER_AUTHORITY=false/);
  assert.match(read('investment-research-self-update.timer'), /OnCalendar=\*-\*-\* \*:37:00 UTC/);
});

test('Research release activation installs and enables the hourly self-update timer', () => {
  assert.match(activate, /install -o root -g root -m 0755 "\$self_update_src\/self-update.sh" \/usr\/local\/sbin\/\.investment-research-self-update\.new/);
  assert.match(activate, /systemctl enable --now investment-research-self-update\.timer/);
  assert.match(activate, /SELF_UPDATE_TIMER_ENABLED=/);
});

test('AI schedules left off by a failed activation are restored for the running release', () => {
  assert.match(script, /restore_ai_for_current/);
  assert.match(script, /AI_RESTORED/);
  const restore = script.slice(script.indexOf('restore_ai_for_current() {'), script.indexOf('ensure_mirror() {'));
  assert.ok(restore.indexOf('validate-isolated') < restore.indexOf('activate-ai-research.sh" activate'));
  assert.doesNotMatch(restore, /activate-server\.sh/);
});

test('staged releases stay readable by the research user and failures keep their reason', () => {
  assert.match(script, /^umask 022$/m);
  assert.doesNotMatch(script, /^umask 077$/m);
  assert.match(script, /repair_isolated_release "\$main_sha"\nwrite_status VALIDATING/);
  assert.match(script, /repair_isolated_release "\$sha"\n  write_status RESTORING_AI/);
  assert.match(script, /chmod -R u\+rwX,go\+rX,go-w -- "\$release"/);
  assert.match(script, /reason="\$\(validation_reason "\$work\/validate-\$attempt\.log"\)"/);
});

test('validation reason falls back to the first error code when no JSON reason exists', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fn = script.slice(script.indexOf('validation_reason() {'), script.indexOf('manual_activation_running() {'));
  const dir = mkdtempSync(join(tmpdir(), 'self-update-reason-'));
  const run = (body) => {
    writeFileSync(join(dir, 'v.log'), body);
    return execFileSync('bash', ['-c', `${fn}\nvalidation_reason "$1"`, 'x', join(dir, 'v.log')], { encoding: 'utf8' });
  };
  assert.equal(run('{"ok":false,"reason":"NATURAL_CYCLE_FAILED"}\n'), 'NATURAL_CYCLE_FAILED');
  assert.equal(run("noise\nError: Cannot find module '/x/research-ai-isolated-transition-v2.mjs'\n    at y\n"),
    "Error: Cannot find module '/x/research-ai-isolated-transition-v2.mjs'");
  assert.equal(run('AI_RESEARCH_CUTOVER_BUSY:research-production-ai-review.service:activating\n'),
    'AI_RESEARCH_CUTOVER_BUSY:research-production-ai-review.service:activating');
  assert.equal(run('nothing useful\n'), '');
});
