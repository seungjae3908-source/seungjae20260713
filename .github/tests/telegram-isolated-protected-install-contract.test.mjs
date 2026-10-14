import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const workflow=fs.readFileSync('.github/workflows/telegram-isolated-protected-install.yml','utf8');
const script=fs.readFileSync('ops/telegram-protected-dormant-install.sh','utf8');
test('only owner-issued comment with a protected Production environment can install',()=>{
 for(const marker of ['environment: production',
   "github.event_name == 'issue_comment'",
   "github.event.comment.author_association == 'OWNER'",
   "github.event.issue.number == 1555",
   '/run-telegram-dormant-install ','group: stock-app-production-live'])
  assert.ok(workflow.includes(marker),marker);
});
test('authentic main push artifact, immutable CI and cryptographic zip verify are mandatory',()=>{
 for(const marker of ['listWorkflowRuns',"event:'push'","run_attempt===1",
   'attestTelegramDormantArtifact','inspectRequiredStatusEvidence',
   'evaluateProductionCiProvenance','evaluatePostMergeStatusProvenance',
   'inspectPostMergeStatusEvidence','TELEGRAM_DORMANT_POSTMERGE_RUN_UNTRUSTED',
   'sha256sum --check --quiet','telegram-dormant-artifact-extract.py',
   'TELEGRAM_DORMANT_STALE_MAIN'])
  assert.ok(workflow.includes(marker),marker);
});
test('remote script is create-only and proves old PM2 remained unchanged',()=>{
 for(const marker of ['TELEGRAM_DORMANT_PROTECTED_REVIEW',
   '/opt/stock-app-data/telegram-isolated-v1',
   '/var/lock/stock-app-deploy.lock','flock -n 8','flock -n 9',
   'pm2_digest','before="$(pm2_digest)"','after="$(pm2_digest)"',
   'telegram-dormant-payload.tar','installation-receipt.json','STAGED_INACTIVE',
   'TELEGRAM_DORMANT_INSTALLER_SOURCE_MISMATCH','INSTALLER_SHA="$3"',
   'TELEGRAM_DORMANT_STATE_SYMLINK_FORBIDDEN',
   'TELEGRAM_DORMANT_STATE_DIRECTORY_UNSAFE',
   'STATE="$BASE/state"','mkdir -m 700 -- "$STATE"'])
  assert.ok(script.includes(marker),marker);
 for(const forbid of ['pm2 restart','pm2 reload','pm2 stop',
   'systemctl start','systemctl restart','sendMessage(',
   'api.telegram.org','psql ','LIVE_TRADING=false','AUTO_TRADING=false',
   'startUserTelegramDeliveryWorker'])
  assert.equal((workflow+script).includes(forbid),false,forbid);
});
test('PR contract job cannot run protected install',()=>{
 assert.match(workflow,/contract:\n\s+if: github\.event_name == 'pull_request'/u);
 assert.ok(workflow.includes("startsWith(github.event.comment.body, '/run-telegram-dormant-install ')"));
});

test('runner guards cannot be substituted after protected SSH transport',()=>{
 assert.ok(workflow.includes('Re-check main just before irreversible create-only operation'));
 assert.ok(workflow.includes('"$(git rev-parse origin/main)" == "$TARGET_SHA"'));
 assert.ok(workflow.includes('bash -s -- $TARGET_SHA $TAR_SHA $INSTALLER_SHA'));
 assert.ok(workflow.includes('< ops/telegram-protected-dormant-install.sh'));
 assert.ok(!workflow.includes('incoming/$TARGET_SHA/telegram-protected-dormant-install.sh'));
 assert.ok(script.includes('sha256sum "$INPUT/install-telegram-isolated-dormant-package.mjs"'));
});
