import fs from 'node:fs';

const workflowPath = '.github/workflows/production-psql-client-install.yml';
const source = fs.readFileSync(workflowPath, 'utf8');

function requireText(text, label = text) {
  if (!source.includes(text)) {
    throw new Error(`missing required install contract: ${label}`);
  }
}

requireText('name: Production PostgreSQL Client Install');
requireText("github.event.issue.number == 23");
requireText("github.event.comment.author_association == 'OWNER'");
requireText("startsWith(github.event.comment.body, '/run-production-psql-client-install ')");
requireText('environment: production');
requireText('EXPECTED_PACKAGE: postgresql-client');
requireText('sudo -n true');
requireText('sudo -n apt-get update -qq');
requireText('sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$EXPECTED_PACKAGE"');
requireText('ops/production-telegram-storage-release-diagnostic.mjs');
requireText('--verify-artifact "$DIAGNOSTIC_ARTIFACT"');
requireText("- Database changed: `false`");
requireText("- Production application deploy executed: `false`");
requireText("- PM2 process restarted by this workflow: `false`");
requireText("- Actual orders: `0`");
requireText("- Live trading authority: `false`");

const installCommands = source.match(/apt-get install/g) ?? [];
if (installCommands.length !== 1) {
  throw new Error(`expected exactly one apt-get install command, found ${installCommands.length}`);
}
const updateCommands = source.match(/apt-get update/g) ?? [];
if (updateCommands.length !== 1) {
  throw new Error(`expected exactly one apt-get update command, found ${updateCommands.length}`);
}

const sudoLines = source
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line.startsWith('sudo -n'));
const allowedSudo = new Set([
  'sudo -n true',
  'sudo -n apt-get update -qq',
  'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "$EXPECTED_PACKAGE"',
]);
for (const line of sudoLines) {
  if (!allowedSudo.has(line)) {
    throw new Error(`unexpected sudo command in Production installer: ${line}`);
  }
}

const forbidden = [
  [/apt-get\s+(?:upgrade|dist-upgrade|full-upgrade|remove|purge|autoremove)\b/i, 'package upgrade/removal'],
  [/^\s*(?:systemctl|service)\b[^\n]*(?:start|restart|stop|enable|disable)\b/im, 'service mutation'],
  [/^\s*pm2\s+(?:start|restart|reload|stop|delete|save)\b/im, 'PM2 mutation'],
  [/\bexport\s+PATH=/i, 'PATH export'],
  [/\/(?:etc\/environment|etc\/profile(?:\.d)?|home\/[^\s]+\/\.bashrc)\b/i, 'persistent PATH/profile mutation'],
  [/\bpsql\b[^\n]*(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|GRANT|REVOKE)\b/i, 'SQL mutation'],
  [/\b(?:order|cancel|amend|transfer|withdrawal)\s*\(/i, 'trading mutation primitive'],
];
for (const [pattern, label] of forbidden) {
  if (pattern.test(source)) {
    throw new Error(`forbidden Production install contract found: ${label}`);
  }
}

if (!source.includes("[[ \"$EXPECTED_PACKAGE\" == 'postgresql-client' ]]")) {
  throw new Error('installer must pin the only package name to postgresql-client');
}
if (!source.includes('SERVER_PACKAGES_BEFORE="$(installed_server_packages)"') ||
    !source.includes('SERVER_PACKAGES_AFTER="$(installed_server_packages)"') ||
    !source.includes('[[ "$SERVER_PACKAGES_AFTER" == "$SERVER_PACKAGES_BEFORE" ]]')) {
  throw new Error('installer must prove no PostgreSQL server package was added');
}
if (!source.includes('[[ "$PM2_AFTER" == "$PM2_BEFORE" ]]')) {
  throw new Error('installer must prove stock-app PM2 pid/restart counter did not change');
}
if (!source.includes('[[ "$ACTIVE_STATE_AFTER" == "$EXPECTED_ACTIVE_SHA" ]]')) {
  throw new Error('installer must prove the Production application SHA did not change');
}

console.log('production psql client install contract: PASS');
