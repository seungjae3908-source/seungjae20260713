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

  const bottomNav = source('stock-analyzer/src/components/bottom-nav.tsx');
  assert.match(bottomNav, /href: '\/auto-trading'.*capability: 'canManageMembers'/);
  assert.match(bottomNav, /menuType === 'tech' \? visibleTechItems : visibleInfoItems/);

  const settings = source('stock-analyzer/src/components/trade-automation-settings.tsx');
  assert.match(settings, /const authorized = Boolean\(fixture\) \|\| auth\.can\('canManageMembers'\);/);
  assert.match(settings, /if \(fixture \|\| !authorized\) return;/);
  assert.match(settings, /if \(!authorized\) return null;/);

  const apiRoutes = source('api-server/src/routes/index.ts');
  assert.match(apiRoutes, /router\.use\('\/trade-automation', requireAdmin\);/);
  assert.doesNotMatch(apiRoutes, /router\.use\('\/trade-automation', requireCapability\('canAccessPaperTrading'\)\);/);

  const migration = source('api-server/supabase/migrations/2026080401_trade_automation_admin_only.sql');
  assert.match(migration, /current_membership_level\(\) = ''admin''/);
  assert.doesNotMatch(migration, /''regular''/);
});
