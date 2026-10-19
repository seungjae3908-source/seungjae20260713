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

test('AI units pinned to a previous release by a failed activation are restored, not reported UP_TO_DATE', () => {
  assert.match(script, /AI_RUNTIME_UNITS=\(research-production-ai-review\.service research-production-workspace-worker\.service\)/);
  assert.match(script, /ai_runtime_healthy\(\) \{ ai_schedules_enabled && ai_runtime_bound_to_current; \}/);
  // Both "already main" branches consult the binding, not only the timer state.
  const upToDate = script.slice(script.indexOf('if [[ "$main_sha" == "$current_sha" ]]; then'), script.indexOf('ensure_mirror\ngit -C "$MIRROR" cat-file'));
  assert.match(upToDate, /if ai_runtime_healthy; then\n    write_status UP_TO_DATE/);
  assert.match(upToDate, /restore_ai_for_current "\$current_sha" "\$\(ai_restore_reason\)"/);
  const noChange = script.slice(script.indexOf('if [[ -z "$changed" ]]; then'), script.indexOf('write_status NO_RESEARCH_CHANGE'));
  assert.match(noChange, /if ! ai_runtime_healthy && git -C "\$MIRROR" cat-file -e/);
  assert.doesNotMatch(noChange, /ai_schedules_enabled/);
});

test('ai_runtime_bound_to_current compares the resolved unit working directory with the current release', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fn = script.slice(script.indexOf('ai_runtime_bound_to_current() {'), script.indexOf('ai_runtime_healthy() {'));
  const dir = mkdtempSync(join(tmpdir(), 'self-update-binding-'));
  const releases = join(dir, 'releases');
  mkdirSync(join(releases, 'a'.repeat(40)), { recursive: true });
  mkdirSync(join(releases, 'b'.repeat(40)), { recursive: true });
  symlinkSync(join(releases, 'b'.repeat(40)), join(dir, 'current'));
  // A fake systemctl answers WorkingDirectory per unit from environment variables.
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\ncase "$2" in\n  research-production-ai-review.service) printf "%s\\n" "$WD_REVIEW" ;;\n  research-production-workspace-worker.service) printf "%s\\n" "$WD_WORKER" ;;\n  *) exit 1 ;;\nesac\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  const run = (review, worker) => {
    try {
      execFileSync('bash', ['-c', `AI_RUNTIME_UNITS=(research-production-ai-review.service research-production-workspace-worker.service)\nCURRENT="$1"\n${fn}\nai_runtime_bound_to_current`, 'x', join(dir, 'current')],
        { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, WD_REVIEW: review, WD_WORKER: worker } });
      return true;
    } catch { return false; }
  };
  // Normal activation: units point at the current symlink.
  assert.equal(run(join(dir, 'current'), join(dir, 'current')), true);
  // Also fine when a unit names the current release directory itself.
  assert.equal(run(join(releases, 'b'.repeat(40)), join(dir, 'current')), true);
  // A rollback pinned the review unit to the previous release: not bound.
  assert.equal(run(join(releases, 'a'.repeat(40)), join(dir, 'current')), false);
  assert.equal(run(join(dir, 'current'), join(releases, 'a'.repeat(40))), false);
  assert.equal(run('', join(dir, 'current')), false);
  assert.equal(run(join(dir, 'current'), join(dir, 'missing')), false);
});

test('a validation that only collided with a running research one-shot is deferred, not counted as a failure', () => {
  const tail = script.slice(script.indexOf('if [[ "$validated" != true ]]; then'), script.indexOf('paper_policy='));
  assert.match(tail, /if \[\[ "\$reason" == AI_RESEARCH_CUTOVER_BUSY:\* \]\]; then/);
  const busy = tail.slice(0, tail.indexOf('record_failure'));
  assert.match(busy, /write_status DEFERRED_RESEARCH_BUSY .*retry next hour; running release unchanged/);
  assert.match(busy, /exit 0/);
  assert.match(tail.slice(tail.indexOf('record_failure')), /record_failure "\$main_sha" validation\n  write_status VALIDATION_FAILED/);
  // Both Korean status maps name the new status.
  assert.match(readFileSync(new URL('../src/research-results-digest-v1.mjs', import.meta.url), 'utf8'), /DEFERRED_RESEARCH_BUSY: '/);
  assert.match(readFileSync(new URL('../bin/research-center-report-ko.mjs', import.meta.url), 'utf8'), /DEFERRED_RESEARCH_BUSY: '/);
});

test('an imminent AI tick is waited out before validation or cutover instead of colliding with it', async () => {
  assert.match(script, /AI_REVIEW_TIMER=research-production-ai-review\.timer/);
  const wait = script.slice(script.indexOf('wait_for_idle_oneshots() {'), script.indexOf('repair_isolated_release() {'));
  assert.match(wait, /if \[\[ -z "\$busy" \]\] && ai_tick_imminent; then busy="\$AI_REVIEW_TIMER:imminent"; fi/);
  const { mkdtempSync, mkdirSync, writeFileSync, chmodSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const fn = script.slice(script.indexOf('ai_tick_imminent() {'), script.indexOf('wait_for_idle_oneshots() {'));
  const dir = mkdtempSync(join(tmpdir(), 'self-update-tick-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'systemctl'), '#!/usr/bin/env bash\nprintf "%s\\n" "$NEXT_ELAPSE"\n');
  chmodSync(join(bin, 'systemctl'), 0o755);
  const run = (next) => {
    try {
      execFileSync('bash', ['-c', `AI_REVIEW_TIMER=t.timer\nAI_TICK_GUARD_SECONDS=180\n${fn}\nai_tick_imminent`],
        { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, NEXT_ELAPSE: next } });
      return true;
    } catch { return false; }
  };
  const stamp = (offsetSeconds) => new Date(Date.now() + offsetSeconds * 1000).toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  assert.equal(run(stamp(60)), true);
  assert.equal(run(stamp(600)), false);
  assert.equal(run(stamp(-60)), false);
  assert.equal(run('n/a'), false);
  assert.equal(run(''), false);
});
