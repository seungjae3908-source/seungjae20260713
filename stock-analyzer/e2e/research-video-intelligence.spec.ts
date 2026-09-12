import { expect, test, type Page, type Route } from '@playwright/test';

const USER='99999999-9999-4999-8999-999999999999';
const AUTH_KEY='sb-127-auth-token';
function fulfill(route:Route,body:unknown,status=200){return route.fulfill({status,contentType:'application/json; charset=utf-8',body:JSON.stringify(body)});}
async function installRuntime(page:Page){
  await page.addInitScript(({authKey,user})=>{const enc=(v:Record<string,unknown>)=>btoa(JSON.stringify(v)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');const exp=4_102_444_800;const token=`${enc({alg:'none',typ:'JWT'})}.${enc({sub:user,role:'authenticated',exp})}.e2e`;localStorage.setItem(authKey,JSON.stringify({access_token:token,refresh_token:'video-research-refresh',expires_in:3600,expires_at:exp,token_type:'bearer',user:{id:user,aud:'authenticated',role:'authenticated',email:'video-research@accounts.invalid',app_metadata:{provider:'email',providers:['email']},user_metadata:{display_name:'연구 관리자'},identities:[],created_at:'2026-09-12T00:00:00.000Z'}}));},{authKey:AUTH_KEY,user:USER});
  await page.route('**/__e2e-supabase/**',async route=>{const pathname=new URL(route.request().url()).pathname;if(pathname.endsWith('/rest/v1/profiles'))return fulfill(route,{id:USER,login_name:'video-research-admin',display_name:'연구 관리자',role:'admin',status:'approved',membership_level:'admin',is_active:true,permissions_updated_at:'2026-09-12T00:00:00.000Z',updated_at:'2026-09-12T00:00:00.000Z'});if(pathname.endsWith('/auth/v1/user'))return fulfill(route,{id:USER,aud:'authenticated',role:'authenticated',email:'video-research@accounts.invalid',app_metadata:{},user_metadata:{}});return fulfill(route,{ok:true});});
  await page.route('**/api/**',async route=>{const pathname=new URL(route.request().url()).pathname;if(pathname==='/api/admin/research/overview')return fulfill(route,{schemaVersion:'research-dashboard-overview-v1',generatedAt:Date.now(),state:{present:true,latestCycleAt:Date.now()},safety:{readOnlyDashboard:true,liveTrading:false,privateApi:false,orderAuthority:false,authorityEvidenceComplete:true,forbiddenAuthorityObserved:false},research:{status:'collecting',failedTasks:0,blockedDataTasks:0,cycles:[]},paper:{runtime:{present:true,status:'collecting',safetyEvidenceComplete:true,lanes:[],privateRequestCount:0,financialMutationCount:0,orderCount:0,liveTrading:false,orderAuthority:false},ledger:{present:true,cycleCount:0,sampleCount:0,positionCount:0,settlementCount:0}},shadow:{groups:[],records:{present:true,totalRecords:0,settledRecords:0,pendingRecords:0}},profitability:{proven:false,status:'NOT_PROVEN',note:'검증 중'}});return fulfill(route,{ok:true,items:[],rows:[],results:[]});});
}

for(const viewport of [{width:320,height:740},{width:1440,height:900}]){
  test(`video research remains fail-closed and responsive at ${viewport.width}px`,async({page})=>{
    await page.setViewportSize(viewport);await installRuntime(page);await page.goto('/research-center');
    await expect(page.getByRole('button',{name:'전문가 보기',exact:true})).toHaveAttribute('aria-pressed','true');
    for(const name of ['일반 보기','전문가 보기','AI Research Copilot','영상 연구'])await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
    await page.getByRole('button',{name:'영상 연구',exact:true}).click();
    const panel=page.getByTestId('research-video-panel');await expect(panel).toBeVisible();
    await expect(panel).toContainText('Research Source Only');await expect(panel).toContainText('Economic Evidence');await expect(panel).toContainText('Profitability Credit');await expect(panel).toContainText('Execution Authority');await expect(panel).toContainText('NONE');
    await expect(panel).toContainText('아직 수집된 영상 연구 자료가 없습니다');await expect(panel).toContainText('UNAVAILABLE / NOT_AUTHORIZED');await expect(panel).toContainText('NON_TESTABLE');
    const overflow=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-window.innerWidth);expect(overflow).toBeLessThanOrEqual(2);
  });
}
