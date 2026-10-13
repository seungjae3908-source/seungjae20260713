import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const navigation=fs.readFileSync('stock-analyzer/src/lib/app-navigation.ts','utf8');
const staging=fs.readFileSync('stock-analyzer/e2e/phase10-staging-readiness.spec.ts','utf8');

const segment=(text,begin,end)=>{
 const a=text.indexOf(begin); const b=text.indexOf(end,a+begin.length);
 assert.ok(a>=0&&b>a,'missing release navigation boundary');
 return text.slice(a,b);
};
test('Staging full navigation test targets exactly accessible four-menu technical flow',()=>{
 const tech=segment(navigation,"    id: 'technical',","    id: 'information',");
 for(const [label,route,capability] of [
  ['검색기','scanner','canAccessBasicInfo'],
  ['AI차트','aiChart','canAccessAiChart'],
  ['과거검증','backtests','canAccessBacktests'],
  ['기술매매','autoTrading','canAccessAutoTrading'],
 ]){
  const n=tech.indexOf("label: '"+label+"'");
  assert.ok(n>=0,'missing technical menu: '+label);
  const before=tech.slice(Math.max(0,n-110),n),after=tech.slice(n,n+130);
  assert.ok(before.includes('APP_ROUTES.'+route),'incorrect route: '+label);
  assert.ok(after.includes("capability: '"+capability+"'"),'wrong capability: '+label);
 }
 assert.ok(staging.includes("await openMenuRoute('technical', '기술매매', '/auto-trading')"));
 assert.ok(staging.includes("['검색기', 'AI차트', '과거검증', '기술매매']"));
 assert.ok(staging.includes("page.getByTestId('technical-mode-paper')"));
 assert.ok(staging.includes("await expectNavigationTransition(page, '/paper-trading'"));
 assert.ok(staging.includes("page.getByTestId('trading-paper-modes')"));
 const auto=fs.readFileSync('stock-analyzer/src/pages/auto-trading.tsx','utf8');
 assert.ok(auto.includes("onClick={() => navigate('/paper-trading')} testId=\"technical-mode-paper\""));
 assert.ok(auto.includes('data-testid="trading-paper-modes"'));
 const professional=fs.readFileSync('stock-analyzer/e2e/auto-trading-professional-ui.spec.ts','utf8');
 assert.ok(professional.includes("expect(navigation.match(/href: APP_ROUTES\\.paperTrading/g) ?? []).toHaveLength(0)"));
 const menuLabels=[...tech.matchAll(/label: '([^']+)'/g)].map(m=>m[1]);
 assert.equal(menuLabels.filter(x=>x==='기술매매').length,1);
 assert.equal(menuLabels.filter(x=>x==='모의매매').length,0);
 assert.ok(!tech.includes('href: APP_ROUTES.paperTrading'));
});
test('Staging full journey information and settings menus stay present',()=>{
 const info=segment(navigation,"    id: 'information',","    id: 'settings',");
 const settings=segment(navigation,"    id: 'settings',","export const APP_ROUTE_PRESENTATIONS:");
 for(const label of ['투자 공부','AI 정보','연구센터','포트폴리오'])
  assert.ok(info.includes("label: '"+label+"'"),'missing information route '+label);
 for(const label of ['앱 설정','계정','회원 관리'])
  assert.ok(settings.includes("label: '"+label+"'"),'missing settings route '+label);
 assert.ok(staging.includes("await openMenuRoute('information', '연구센터', '/research-center')"));
 assert.ok(staging.includes("await openMenuRoute('settings', '계정', '/account')"));
});
