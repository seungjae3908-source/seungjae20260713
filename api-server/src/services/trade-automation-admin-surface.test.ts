import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';

function source(relativePath: string) {
  return readFileSync(path.join(process.cwd(), relativePath), 'utf8');
}

test('auto trading remains administrator-only across route, menu, settings, API, and database policy', () => {
  const app = source('stock-analyzer/src/App.tsx');
  assert.match(app, /function AutoTradingAccess\(\) \{ return gated\('canManageMembers', <AutoTradingPage \/>\); \}/);
  assert.match(app, /<Route path="\/auto-trading" component=\{AutoTradingAccess\} \/>/);
  assert.doesNotMatch(app, /<Route path="\/auto-trading" component=\{ScannerAccess\} \/>/);
  assert.match(app, /const phase12E2EEnabled = import\.meta\.env\.VITE_PHASE12_E2E === 'true';/);
  assert.match(app, /\{phase12E2EEnabled \? <Route path="\/__phase12-trade-automation-e2e"/);
  assert.doesNotMatch(app, /<Route path="\/__phase12-trade-automation-e2e" component=\{Phase12TradeAutomationE2EPage\} \/>\s*(?!: null)/);

  const bottomNav = source('stock-analyzer/src/components/bottom-nav.tsx');
  assert.match(bottomNav, /href: '\/auto-trading'.*capability: 'canManageMembers'/);
  assert.match(bottomNav, /const visibleTechItems = TECH_MENU_ITEMS\.filter/);
  assert.match(bottomNav, /menuType === 'tech' \? visibleTechItems : visibleInfoItems/);

  const settings = source('stock-analyzer/src/components/trade-automation-settings.tsx');
  assert.match(settings, /const authorized = Boolean\(fixture\) \|\| auth\.can\('canManageMembers'\);/);
  assert.match(settings, /if \(fixture \|\| !authorized\) return;/);
  assert.match(settings, /if \(!authorized\) return null;/);
  assert.match(settings, /const \[loading, setLoading\] = useState\(!fixture && authorized\);/);

  const apiRoutes = source('api-server/src/routes/index.ts');
  const authenticatedPosition = apiRoutes.indexOf('router.use(requireAuthenticated);');
  const adminPosition = apiRoutes.indexOf("router.use('/trade-automation', requireAdmin);");
  const tradeRouterPosition = apiRoutes.indexOf("router.use('/trade-automation', tradeAutomationRouter);");
  assert.ok(authenticatedPosition >= 0 && adminPosition > authenticatedPosition);
  assert.ok(tradeRouterPosition > adminPosition);
  assert.doesNotMatch(apiRoutes, /router\.use\('\/trade-automation', requireCapability\('canAccessPaperTrading'\)\);/);

  const auth = source('api-server/src/middleware/auth.ts');
  assert.match(auth, /getUserSupabase\(token\)\s*\.from\('profiles'\)/);
  assert.match(auth, /if \(!req\.member \|\| !hasCapability\(req\.member, 'canManageMembers'\)\)/);
  assert.doesNotMatch(auth, /req\.body.*canManageMembers/);
  assert.doesNotMatch(auth, /user_metadata.*canManageMembers/);

  const migration = source('api-server/supabase/migrations/2026080401_trade_automation_admin_only.sql');
  assert.match(migration, /current_membership_level\(\) = ''admin''/);
  assert.match(migration, /auth\.uid\(\) = user_id/);
  assert.doesNotMatch(migration, /''regular''/);
});
