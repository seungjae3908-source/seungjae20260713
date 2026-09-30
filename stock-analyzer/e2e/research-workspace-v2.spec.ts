import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildResearchWorkspace } from '../../packages/external-research/src/research-workspace-v1.js';

// Synthetic QA only. No external provider, real account, video inference or return claim.
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`../../packages/external-research/test/fixtures/research-workspace-v2/${name}.json`,import.meta.url),'utf8'));
const workspace=buildResearchWorkspace({videoEvidence:fixture('snapshot'),registry:fixture('registry'),policy:fixture('policy')});
const USER='99999999-9999-4999-8999-999999999999';
const workerFixture={schemaVersion:'research-worker-status-v9',available:true,checkedAt:'2026-09-26T04:00:00.000Z',workerState:'ACTIVE',lastHeartbeatAt:'2026-09-26T03:59:55.000Z',currentTaskKind:'VIDEO_PREPARE',counts:{queued:2,running:1,succeeded:7,failed:1,blocked:1},authority:{executionAuthority:'NONE',automaticActivation:false,providerCallsFromStatus:0}};
const providerFixture={schemaVersion:'research-provider-readiness-v8',checkedAt:'2026-09-26T03:30:00.000Z',source:'API_PROCESS',scope:'SELECTED_RUNTIME_ONLY',providers:['youtube','gemini','groq'].map(provider=>({provider,credentialState:'PRESENT',modelState:provider==='youtube'?'NOT_APPLICABLE':'EXPLICIT',callVerified:false,quotaState:'NOT_CHECKED',billingState:'NOT_CHECKED'})),unmappedGenericCredential:false,authority:{executionAuthority:'NONE',providerCalls:0,environmentMutated:false,automaticActivation:false}};
const orchestratorFixture={schemaVersion:'research-orchestrator-status-v10',available:true,checkedAt:'2026-09-26T05:30:00.000Z',totals:{pending:2,processing:1,reviewRequired:1,completed:4},stageCounts:{YOUTUBE_SOURCE:1,GEMINI_VIDEO:1,GROQ_ADVERSARIAL_REVIEW:1,RULE_COMPLETENESS:1,CANONICAL_COMPILER:1,BACKTEST:1,RESULT_PERSIST:1,ADOPTION_REVIEW:1},markets:{stockCompleted:3,cryptoCompleted:1},authority:{executionAuthority:'NONE',automaticActivation:false,automaticAdoption:false,providerCallsFromStatus:0,profitabilityAuthority:'BACKTESTER_ONLY'}};
const oneShotFixture={schemaVersion:'research-one-shot-review-v15',available:true,checkedAt:'2026-09-26T08:10:00.000Z',
 status:'HUMAN_RULE_DIGEST_REVIEW',reason:'HUMAN_RULE_DIGEST_REVIEW_REQUIRED',manifestDigest:'a'.repeat(64),packageDigest:'b'.repeat(64),
 reviewedRuleDigestCandidate:'c'.repeat(64),providerCalls:{gemini:1,groq:1},sourceTruthVerified:false,entireVideoVerified:false,
 observations:[
  {observationIndex:0,atSec:12,kind:'ENTRY',description:'Synthetic entry claim',verdict:'CHALLENGE',reason:'Entry condition remains ambiguous.'},
  {observationIndex:1,atSec:18,kind:'EXIT',description:'Synthetic exit claim',verdict:'ACCEPT_AS_CLAIM',reason:'Exit claim is structurally reviewable.'},
 ],limitations:['Synthetic review fixture only.'],groq:{summary:'Adversarial review requires human confirmation.',disposition:'REVIEW_REQUIRED'},
 missingRuleKinds:['STOP_LOSS'],authority:{readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,automaticBacktest:false,
  automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'}};
const oneShotInsufficient={schemaVersion:'research-one-shot-review-v15',available:true,checkedAt:'2026-09-26T08:10:00.000Z',
 status:'SOURCE_EVIDENCE_REVIEW_NO_RETRY',reason:'GEMINI_INSUFFICIENT_EVIDENCE',manifestDigest:'a'.repeat(64),packageDigest:null,
 reviewedRuleDigestCandidate:null,providerCalls:{gemini:1,groq:0},sourceTruthVerified:false,entireVideoVerified:false,observations:[],
 limitations:['Video content was insufficient for reviewed rules.'],groq:null,missingRuleKinds:[],
 authority:{readOnly:true,providerCallsFromRead:0,automaticBinding:false,automaticCompiler:false,automaticBacktest:false,
  automaticAdoption:false,profitabilityProven:false,executionAuthority:'NONE'}};
test('AI chat user surface exposes factual provider and fallback metadata without secrets', () => {
  const aiChat = readFileSync(new URL('../src/pages/ai-chat.tsx', import.meta.url), 'utf8');
  expect(aiChat).toContain('data-testid="ai-chat-provider-meta"');
  expect(aiChat).toContain("provider === 'google-gemini'");
  expect(aiChat).toContain("provider === 'groq'");
  expect(aiChat).toContain('Fallback 사용');
  expect(aiChat).toContain('Primary 응답');
  expect(aiChat).toContain('providerLatencyMs');
  expect(aiChat).not.toContain('GEMINI_API_KEY');
  expect(aiChat).not.toContain('GROQ_API_KEY');
});

async function setup(page:Page,payload:unknown={available:true,workspace},status=200,providerPayload:unknown=providerFixture,providerStatus=200,workerPayload:unknown=workerFixture,workerStatus=200,orchestratorPayload:unknown=orchestratorFixture,orchestratorStatus=200,oneShotPayload:unknown=oneShotFixture,oneShotStatus=200) {
  await page.addInitScript(user=>{
    const encode=(x:Record<string,unknown>)=>btoa(JSON.stringify(x)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const token=`${encode({alg:'none',typ:'JWT'})}.${encode({sub:user,role:'authenticated',exp:4102444800})}.e2e`;
    localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'TEST_ONLY',expires_in:3600,expires_at:4102444800,token_type:'bearer',user:{id:user,aud:'authenticated',role:'authenticated',email:'test@accounts.invalid',app_metadata:{provider:'email',providers:['email']},user_metadata:{},identities:[],created_at:'2026-09-01T00:00:00.000Z'}}));
  },USER);
  await page.route('**/__e2e-supabase/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    const body=path.endsWith('/rest/v1/profiles')?{id:USER,login_name:'test-admin',display_name:'검증용 관리자',role:'admin',status:'approved',membership_level:'admin',is_active:true}:path.endsWith('/auth/v1/user')?{id:USER,aud:'authenticated',role:'authenticated',email:'test@accounts.invalid'}:{ok:true};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  const requests:Array<{path:string;method:string;hasAuth:boolean}>=[];
  await page.route('**/api/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    requests.push({path,method:request.method(),hasAuth:Boolean(request.headers().authorization)});
    if(path==='/api/auth/profile')return route.fulfill({contentType:'application/json',body:JSON.stringify({id:USER,login_name:'test-admin',display_name:'검증용 관리자',role:'admin',status:'approved',membership_level:'admin',is_active:true})});
    if(path==='/api/research/video/evidence/workspace/providers')return route.fulfill({status:providerStatus,contentType:'application/json',body:JSON.stringify(providerPayload)});
    if(path==='/api/research/video/evidence/workspace/worker')return route.fulfill({status:workerStatus,contentType:'application/json',body:JSON.stringify(workerPayload)});
    if(path==='/api/research/video/evidence/workspace/orchestrator')return route.fulfill({status:orchestratorStatus,contentType:'application/json',body:JSON.stringify(orchestratorPayload)});
    if(path==='/api/research/video/evidence/workspace/one-shot-review')return route.fulfill({status:oneShotStatus,contentType:'application/json',body:JSON.stringify(oneShotPayload)});
    if(path==='/api/research/video/evidence/workspace')return route.fulfill({status,contentType:'application/json',body:JSON.stringify(payload)});
    if(path==='/api/research/video/evidence')return route.fulfill({contentType:'application/json',body:JSON.stringify({available:false,dataState:'UNKNOWN'})});
    return route.fulfill({contentType:'application/json',body:JSON.stringify({ok:true,items:[],rows:[],results:[]})});
  });
  await page.goto('/research-center');
  await page.getByRole('button',{name:'영상',exact:true}).click();
  await page.getByRole('button',{name:'전략·백테스트',exact:true}).click();
  return requests;
}
for (const width of [390,768,1024,1440]) test(`mounted workspace filters and disabled adoption ${width}px`,async({page},testInfo)=>{
  await page.setViewportSize({width,height:900});const requests=await setup(page);
  const panel=page.getByTestId('research-workspace-panel');await expect(panel).toBeVisible();
  await expect(panel.getByTestId('workspace-strategy')).toHaveCount(2);
  const providerPanel=panel.getByTestId('research-provider-status');
  await expect(providerPanel.locator('[data-provider]')).toHaveCount(3);
  await expect(providerPanel).toContainText('설정 상태와 실제 호출 검증은 별개입니다.');
  await expect(providerPanel.locator('[data-provider="gemini"]')).toContainText('설정 확인');
  await expect(providerPanel.locator('[data-provider="gemini"]')).toContainText('실제 호출 미검증');
  await expect(providerPanel.locator('[data-provider="groq"]')).toContainText('실제 호출 미검증');
  const workerPanel=panel.getByTestId('research-worker-status');await expect(workerPanel).toContainText('작업자 신호 확인');await expect(workerPanel).toContainText('확인 필요');
  const orchestratorPanel=panel.getByTestId('research-orchestrator-status');await expect(orchestratorPanel).toContainText('Groq 반대검토');await expect(orchestratorPanel).toContainText('주식 완료');await expect(orchestratorPanel).toContainText('코인 완료');await expect(orchestratorPanel).toContainText('백테스터 결과만 사용');
  const oneShotPanel=panel.getByTestId('research-one-shot-review');await expect(oneShotPanel).toContainText('사람 검토 대기');await expect(oneShotPanel).toContainText('반론·충돌 있음');await expect(oneShotPanel).toContainText('구조상 검토 가능 · 사실 인증 아님');await expect(oneShotPanel).toContainText('AI 동의는 수익성 증거가 아니며');
  await expect(oneShotPanel.getByTestId('one-shot-observations').locator('article')).toHaveCount(2);
  await page.screenshot({path:testInfo.outputPath(`providers-${width}.png`),fullPage:true});
  await panel.getByRole('button',{name:'주식',exact:true}).click();await expect(panel.getByTestId('workspace-strategy')).toHaveCount(1);
  await expect(panel.getByTestId('workspace-strategy')).toHaveAttribute('data-market','US_STOCK');
  await panel.getByRole('button',{name:'코인',exact:true}).click();await expect(panel.getByTestId('workspace-strategy')).toHaveAttribute('data-market','CRYPTO_SPOT');
  await panel.getByLabel('세부 시장').selectOption('CRYPTO_FUTURES');await expect(panel).toContainText('이 분류에는 연결된 전략이 없습니다.');
  await panel.getByLabel('세부 시장').selectOption('CRYPTO_SPOT');await panel.getByText('근거와 누락 확인',{exact:true}).click();await expect(panel).toContainText('AI 보완 가정');
  await expect(panel.getByRole('button',{name:'실거래 적용',exact:true})).toBeDisabled();
  const calls=requests.filter(x=>x.path.endsWith('/workspace'));expect(calls.length).toBeGreaterThan(0);expect(calls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
  const providerCalls=requests.filter(x=>x.path.endsWith('/workspace/providers'));expect(providerCalls.length).toBeGreaterThan(0);expect(providerCalls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
  const workerCalls=requests.filter(x=>x.path.endsWith('/workspace/worker'));expect(workerCalls.length).toBeGreaterThan(0);expect(workerCalls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
  const orchestratorCalls=requests.filter(x=>x.path.endsWith('/workspace/orchestrator'));expect(orchestratorCalls.length).toBeGreaterThan(0);expect(orchestratorCalls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
  const oneShotCalls=requests.filter(x=>x.path.endsWith('/workspace/one-shot-review'));expect(oneShotCalls.length).toBeGreaterThan(0);expect(oneShotCalls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth-window.innerWidth)).toBeLessThanOrEqual(2);
});
test('unavailable registry is not rendered as a zero-return result',async({page})=>{
 await setup(page,{available:false,reason:'TRUST_POLICY_UNAVAILABLE'});const panel=page.getByTestId('research-workspace-panel');await expect(panel).toContainText('검증 가능한 연구 기록이 아직 연결되지 않았습니다.');await expect(panel.getByTestId('workspace-strategy')).toHaveCount(0);
});
test('permission failure clears results and explains access',async({page})=>{
 await setup(page,{error:'RESEARCH_ACCESS_REQUIRED'},403);await expect(page.getByRole('alert')).toContainText('관리자 권한');await expect(page.getByTestId('workspace-strategy')).toHaveCount(0);
});

test('provider read failure does not mean all keys are missing or hide strategy results',async({page})=>{
 await setup(page,{available:true,workspace},200,{error:'UNAVAILABLE'},503);
 const status=page.getByTestId('research-provider-status');await expect(status).toContainText('미연결로 단정하지 않습니다.');
 await expect(status.locator('[data-provider]')).toHaveCount(0);await expect(page.getByTestId('workspace-strategy')).toHaveCount(2);
});
test('provider failure after refresh clears previously visible configuration',async({page})=>{
 await setup(page);const status=page.getByTestId('research-provider-status');await expect(status.locator('[data-provider]')).toHaveCount(3);
 await page.route('**/api/research/video/evidence/workspace/providers',route=>route.fulfill({status:403,contentType:'application/json',body:'{}'}));
 await page.getByTestId('research-workspace-panel').getByRole('button',{name:'다시 확인',exact:true}).click();
 await expect(status).toContainText('연결 상태를 조회하지 못했습니다.');await expect(status.locator('[data-provider]')).toHaveCount(0);
});
test('forged connectivity response is not rendered as provider success',async({page})=>{
 const forged=structuredClone(providerFixture);forged.providers[1].callVerified=true;
 await setup(page,{available:true,workspace},200,forged);const status=page.getByTestId('research-provider-status');
 await expect(status).toContainText('연결 상태를 조회하지 못했습니다.');await expect(status.locator('[data-provider]')).toHaveCount(0);
});

test('missing worker store is not rendered as zero completed research',async({page})=>{
 await setup(page,{available:true,workspace},200,providerFixture,200,{schemaVersion:'research-worker-status-v9',available:false,reason:'WORKER_STORE_NOT_INSTALLED'});
 const status=page.getByTestId('research-worker-status');await expect(status).toContainText('0건으로 간주하지 않습니다.');await expect(status).not.toContainText('완료 0');
});
test('stale worker heartbeat is explicit, not active',async({page})=>{
 const stale=structuredClone(workerFixture);stale.workerState='STALE';await setup(page,{available:true,workspace},200,providerFixture,200,stale);
 await expect(page.getByTestId('research-worker-status')).toContainText('작업자 신호 만료');
});
test('forged worker automatic activation is rejected by UI parser',async({page})=>{
 const forged=structuredClone(workerFixture);forged.authority.automaticActivation=true;await setup(page,{available:true,workspace},200,providerFixture,200,forged);
 await expect(page.getByTestId('research-worker-status')).toContainText('0건으로 간주하지 않습니다.');
});

test('missing orchestrator status is not rendered as zero completed research',async({page})=>{
 await setup(page,{available:true,workspace},200,providerFixture,200,workerFixture,200,{schemaVersion:'research-orchestrator-status-v10',available:false,reason:'ORCHESTRATOR_NOT_ACTIVATED'});
 const status=page.getByTestId('research-orchestrator-status');await expect(status).toContainText('완료 0건으로 간주하지 않습니다.');await expect(status).not.toContainText('주식 완료');
});
test('forged orchestrator adoption authority is rejected by UI parser',async({page})=>{
 const forged=structuredClone(orchestratorFixture);forged.authority.automaticAdoption=true;
 await setup(page,{available:true,workspace},200,providerFixture,200,workerFixture,200,forged);
 await expect(page.getByTestId('research-orchestrator-status')).toContainText('완료 0건으로 간주하지 않습니다.');
});


test('missing one-shot review is not rendered as success or zero',async({page})=>{
 await setup(page,{available:true,workspace},200,providerFixture,200,workerFixture,200,orchestratorFixture,200,
  {schemaVersion:'research-one-shot-review-v15',available:false,reason:'ONE_SHOT_NOT_EXECUTED'});
 const status=page.getByTestId('research-one-shot-review');
 await expect(status).toContainText('성공·0건으로 간주하지 않습니다.');
 await expect(status).not.toContainText('사람 검토 대기');
});

test('Gemini insufficient evidence is distinct and does not pretend Groq or digest review happened',async({page})=>{
 await setup(page,{available:true,workspace},200,providerFixture,200,workerFixture,200,orchestratorFixture,200,oneShotInsufficient);
 const status=page.getByTestId('research-one-shot-review');
 await expect(status).toContainText('Gemini 증거 부족 · 자동 재실행 금지');
 await expect(status).toContainText('Gemini 1회 · Groq 0회');
 await expect(status).toContainText('digest 승인·컴파일·백테스트로 진행하지 않습니다.');
 await expect(status).not.toContainText('사람 검토 대기');
});

test('forged one-shot automatic binding authority is rejected by UI parser',async({page})=>{
 const forged=structuredClone(oneShotFixture);forged.authority.automaticBinding=true;
 await setup(page,{available:true,workspace},200,providerFixture,200,workerFixture,200,orchestratorFixture,200,forged);
 await expect(page.getByTestId('research-one-shot-review')).toContainText('성공·0건으로 간주하지 않습니다.');
});
