import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { policyModeForAutomaticEnabled } from '../src/lib/trade-automation-policy-mode';

function code(relative: string) {
  return fs.readFileSync(path.resolve(process.cwd(), relative), 'utf8');
}

test('AUTO OFF persists canonical approval mode required before administrator 4x1m Paper bootstrap', () => {
  expect(policyModeForAutomaticEnabled(false)).toBe('approval');
  expect(policyModeForAutomaticEnabled(true)).toBe('automatic');

  const component = code('src/components/trade-automation-settings.tsx');
  const api = code('../api-server/src/routes/trade-automation.ts');
  const journal = code('../api-server/src/routes/paper-journal.ts');

  expect(component).toContain('mode: policyModeForAutomaticEnabled(draft.automaticEnabled)');
  expect(component).toContain('mode: policyModeForAutomaticEnabled(nextEnabled)');
  expect(component).toContain('mode: policy.mode,');
  expect(component).toContain('data-testid="automatic-policy-approval-off-warning"');
  expect(component).toContain('재활성화 시 시장을 다시 선택해야 합니다.');

  // This is a two-dimensional OFF gate. The server resets all automatic
  // market/provider entries in approval mode, while the wallet creator checks
  // BOTH dimensions. Never weaken the backend checks to fit a broken UI.
  expect(api).toContain("if (candidate.mode !== 'automatic') {");
  expect(api).toContain('candidate.automaticEnabled = false;');
  expect(api).toContain('candidate.marketEnabled = { domestic_stock: false, us_stock: false, crypto_spot: false, crypto_futures: false };');
  expect(journal).toContain("if (policy.automaticEnabled || policy.mode === 'automatic')");
  expect(journal).toContain("blockers.push('ADMIN_PAPER_MEMBER_AUTO_MUST_BE_OFF')");
  expect(journal).toContain("if (!adminAutomaticLiveGateOff())");
});

test('AUTO enable cannot be mapped to approval or treated as wallet creation authority', () => {
  expect(policyModeForAutomaticEnabled(true)).toBe('automatic');
  expect(policyModeForAutomaticEnabled(false)).toBe('approval');

  const component = code('src/components/trade-automation-settings.tsx');
  expect(component).toContain('automaticEnabled: nextEnabled,');
  expect(component).toContain("authorizedFetch('/api/trade-automation/policy'");
  expect(component).not.toContain("  async function save(confirmed: boolean) {\n    const outbound: UiPolicy = {\n      ...draft,\n      mode: 'automatic',");
});

test('sticky stop preserves locked master/save while explicit OFF-only path re-reads server policy', () => {
  const component = code('src/components/trade-automation-settings.tsx');
  const server = code('../api-server/src/routes/trade-automation.ts');
  expect(component).toContain('disabled={effectiveStopped}');
  expect(component).toContain('data-testid="automatic-policy-safe-off-during-stop"');
  expect(component).toContain('saveSafeOffDuringStop()');
  expect(component).toContain("authorizedFetch('/api/trade-automation/status')");
  expect(component).toContain("before.policy, mode: 'approval', automaticEnabled: false");
  expect(component).toContain("AUTO_OFF_STOP_PRESERVATION_READBACK_INVALID");
  expect(component).toContain('기존 Live 자동포지션의 자동청산 감시가 중단될 수 있으므로');
  expect(server).toContain("if ((current.emergencyStopped || current.newEntriesStopped) && enablingAutomatic)");
  expect(server).toContain("if (candidate.mode !== 'automatic') {");
  expect(server).toContain('enforceMemberTradingPolicy(candidate, current)');
});
