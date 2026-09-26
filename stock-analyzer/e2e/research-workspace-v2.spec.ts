import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { buildResearchWorkspace } from '../../packages/external-research/src/research-workspace-v1.js';

// Synthetic QA only. No external provider, real account, video inference or return claim.
const fixture=(name:string)=>JSON.parse(readFileSync(new URL(`../../packages/external-research/test/fixtures/research-workspace-v2/${name}.json`,import.meta.url),'utf8'));
const workspace=buildResearchWorkspace({videoEvidence:fixture('snapshot'),registry:fixture('registry'),policy:fixture('policy')});
const USER='99999999-9999-4999-8999-999999999999';
const providerFixture={schemaVersion:'research-provider-readiness-v8',checkedAt:'2026-09-26T03:30:00.000Z',source:'API_PROCESS',scope:'SELECTED_RUNTIME_ONLY',providers:['youtube','gemini','groq'].map(provider=>({provider,credentialState:'PRESENT',modelState:provider==='youtube'?'NOT_APPLICABLE':'EXPLICIT',callVerified:false,quotaState:'NOT_CHECKED',billingState:'NOT_CHECKED'})),unmappedGenericCredential:false,authority:{executionAuthority:'NONE',providerCalls:0,environmentMutated:false,automaticActivation:false}};
async function setup(page:Page,payload:unknown={available:true,workspace},status=200,providerPayload:unknown=providerFixture,providerStatus=200) {
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
  await expect(providerPanel).toContainText('실제 호출·영상 분석·무료 한도는 별도 검증');
  await page.screenshot({path:testInfo.outputPath(`providers-${width}.png`),fullPage:true});
  await panel.getByRole('button',{name:'주식',exact:true}).click();await expect(panel.getByTestId('workspace-strategy')).toHaveCount(1);
  await expect(panel.getByTestId('workspace-strategy')).toHaveAttribute('data-market','US_STOCK');
  await panel.getByRole('button',{name:'코인',exact:true}).click();await expect(panel.getByTestId('workspace-strategy')).toHaveAttribute('data-market','CRYPTO_SPOT');
  await panel.getByLabel('세부 시장').selectOption('CRYPTO_FUTURES');await expect(panel).toContainText('이 분류에는 연결된 전략이 없습니다.');
  await panel.getByLabel('세부 시장').selectOption('CRYPTO_SPOT');await panel.getByText('근거와 누락 확인',{exact:true}).click();await expect(panel).toContainText('AI 보완 가정');
  await expect(panel.getByRole('button',{name:'실거래 적용',exact:true})).toBeDisabled();
  const calls=requests.filter(x=>x.path.endsWith('/workspace'));expect(calls.length).toBeGreaterThan(0);expect(calls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
  const providerCalls=requests.filter(x=>x.path.endsWith('/workspace/providers'));expect(providerCalls.length).toBeGreaterThan(0);expect(providerCalls.every(x=>x.method==='GET'&&x.hasAuth)).toBe(true);
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
