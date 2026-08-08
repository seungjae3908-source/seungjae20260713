import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const repositoryRoot = path.resolve(process.cwd(), '..');
const failures = [];

async function text(relative) {
  return readFile(path.join(repositoryRoot, relative), 'utf8');
}

async function walk(directory) {
  const output = [];
  for (const name of await readdir(directory)) {
    const full = path.join(directory, name);
    const info = await stat(full);
    if (info.isDirectory()) output.push(...await walk(full));
    else output.push(full);
  }
  return output;
}

function assert(condition, message) {
  if (!condition) failures.push(message);
}

const cryptoAuto = await text('api-server/src/routes/crypto-auto.ts');
const normalizedCryptoAuto = cryptoAuto.replace(/\r\n/g, '\n');
const cryptoAutoBlob = createHash('sha1')
  .update(`blob ${Buffer.byteLength(normalizedCryptoAuto)}\0${normalizedCryptoAuto}`).digest('hex');
assert(cryptoAutoBlob === '4b964ddf329c58da3a43cd6024c1130fd3527b61', 'crypto-auto.ts changed from the verified baseline');

const routes = await text('api-server/src/routes/index.ts');
const disabledIndex = routes.indexOf("router.use('/crypto/futures/auto', privateExchangeDisabled)");
const cryptoMountIndex = routes.indexOf("router.use('/', cryptoRouter)");
assert(disabledIndex >= 0 && cryptoMountIndex > disabledIndex, 'actual-trading routes are not blocked before crypto router mount');
assert(routes.includes("router.get('/crypto/spot/accounts', privateExchangeDisabled)"), 'spot private account route is not blocked');
assert(routes.includes("router.get('/crypto/futures/account', privateExchangeDisabled)"), 'futures private account route is not blocked');
assert(routes.includes("router.get('/crypto/futures/positions', privateExchangeDisabled)"), 'futures private position route is not blocked');
const legacyStockBlockIndex = routes.indexOf("router.use('/stocks/auto-trade', privateExchangeDisabled)");
const stocksMountIndex = routes.indexOf("router.use('/stocks', stocksRouter)");
assert(legacyStockBlockIndex >= 0 && stocksMountIndex > legacyStockBlockIndex, 'legacy stock/US live-order routes are not blocked before stock router mount');

const automationRoute = await text('api-server/src/routes/trade-automation.ts');
const automationService = await text('api-server/src/services/trade-automation.service.ts');
const automationRepository = await text('api-server/src/services/trade-automation.repository.ts');
const automationMigration = await text('api-server/supabase/migrations/2026080301_trade_automation_integration.sql');
const aiChatRoute = await text('api-server/src/routes/ai-chat.ts');
const aiChatService = await text('api-server/src/services/ai-chat.service.ts');
const automationUi = await text('stock-analyzer/src/components/trade-automation-settings.tsx');
assert(automationService.includes("process.env.ORDER_EXECUTION_ENABLED === 'true'")
  && automationService.includes("process.env.LIVE_TRADING_ACTIVATION_APPROVED === 'true'"), 'live execution does not require both server and explicit activation gates');
assert(automationRoute.includes('encryptTradingCredentials'), 'member exchange credentials are not encrypted before storage');
assert(automationRepository.includes('hasSupabaseServerKey') && automationRepository.includes('secureClient()'),
  'encrypted exchange credentials are not restricted to the server Supabase client');
assert(automationMigration.includes('revoke all on public.trade_exchange_connections from anon, authenticated')
  && !automationMigration.includes('select(encrypted_credentials)'),
  'encrypted credential column is readable by browser roles');
assert(automationRoute.includes("router.post('/admin/emergency-stop', requireAdmin")
  && automationMigration.includes('revoke all privileges on table public.trade_system_controls from public, anon, authenticated'),
  'persistent global emergency stop is not restricted to an admin route and service-only storage');
assert(!automationUi.includes('credentials:'), 'frontend contains an exchange credential payload');
assert(!/(?:trade-automation|trade-execution|place-order|\/v1\/orders)/i.test(`${aiChatRoute}\n${aiChatService}`), 'AI chat imports or calls the trading execution surface');

const phase8SensitiveFiles = [
  'api-server/src/services/paper-journal-analytics.service.ts',
  'api-server/src/services/paper-journal-sync.service.ts',
  'api-server/src/services/member-administration.service.ts',
  'api-server/src/routes/paper-journal.ts',
  'api-server/src/routes/admin.ts',
  'stock-analyzer/src/lib/paper-journal-sync.ts',
  'stock-analyzer/src/lib/paper-journal-sync-storage.ts',
  'stock-analyzer/src/pages/phase8-release-candidate-e2e.tsx',
  'api-server/src/services/trade-automation.service.ts',
  'api-server/src/services/trade-execution.service.ts',
  'api-server/src/services/trade-automation.repository.ts',
  'api-server/src/routes/trade-automation.ts',
];
const phase8Text = (await Promise.all(phase8SensitiveFiles.map(text))).join('\n');
assert(!/(?:api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|cohere\.ai)/i.test(phase8Text), 'Phase 8 code contains an external AI endpoint');
assert(!/(?:SUPABASE_SERVICE_ROLE_KEY|service_role)/i.test(await text('stock-analyzer/src/lib/auth.tsx')), 'frontend auth source references a service role key');

const dist = path.join(repositoryRoot, 'stock-analyzer/dist');
const distFiles = await walk(dist);
let bundle = '';
for (const file of distFiles) {
  if (/\.(?:js|css|html|json|map)$/i.test(file)) bundle += await readFile(file, 'utf8');
}
assert(!/(?:SUPABASE_SERVICE_ROLE_KEY|service_role)/i.test(bundle), 'frontend production bundle contains service-role material');
// Exclusion-field labels such as originalUserNote are an expected public
// contract. Only fixture values or actual private content are treated as leaks.
assert(!/(?:private note|private@example\.com|user\d+@example\.com)/i.test(bundle), 'frontend production bundle contains private journal fixture material');

const reviewSource = await text('api-server/src/services/paper-journal-analytics.service.ts');
for (const excluded of ['email', 'name', 'birthDate', 'apiKey', 'secret', 'accountNumber', 'originalUserNote', 'internalDatabaseUuid', 'fullOrderPayload']) {
  assert(reviewSource.includes(`'${excluded}'`) || reviewSource.includes(`"${excluded}"`), `review dataset exclusion missing: ${excluded}`);
}

const storageSource = await text('stock-analyzer/src/lib/paper-journal-sync-storage.ts');
assert(storageSource.includes('paperOwnerNamespace'), 'local storage namespace hashing is missing');
assert(!/seungjae\.paper-(?:trading|journal)[^'"`]*:\$\{userId\}/.test(storageSource), 'raw user ID is interpolated into a localStorage key');

if (failures.length) {
  for (const failure of failures) console.error(`[phase8-security] ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`[phase8-security] verified ${phase8SensitiveFiles.length} sensitive source files and ${distFiles.length} production bundle files`);
  console.log('[phase8-security] actual order/private exchange paths blocked; external AI endpoints absent; service role absent from frontend bundle');
}
