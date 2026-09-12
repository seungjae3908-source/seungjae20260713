import { expect, test, type Page, type Route } from '@playwright/test';

const USER='99999999-9999-4999-8999-999999999999';
const AUTH_KEY='sb-127-auth-token';
const SAFETY={researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE',paidProviderEnabled:false,scheduleActive:false,automaticDiscoveryEnabled:false,liveTrading:false,privateTradingApi:false,realOrderEnabled:false,credentialMutation:false,transcriptDownloadEnabled:false} as const;
const MEASURED_VIDEO_EVIDENCE={
  ok:true,available:true,dataState:'MEASURED',runtimeVersion:'video-research-public-provider-runtime-v3',status:'SUCCESS',provider:'YOUTUBE_DATA_API_V3',providerAccess:'OFFICIAL_PUBLIC_API',requestMode:'READ_ONLY_GET',query:'TEST_ONLY swing strategy',pagesUsed:1,quotaState:'BOUNDED_ESTIMATE_USED_100_UNITS',credentialConfigured:true,credentialValueExposed:false,sourceCount:1,
  records:[{videoId:'TEST_ONLY_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=TEST_ONLY_VIDEO',title:'TEST_ONLY sanitized research source',channelOrPublisher:'TEST_ONLY channel',publishedAt:'2026-09-12T00:00:00.000Z',discoveredAt:'2026-09-13T00:00:00.000Z',language:'ko',durationSec:321,transcriptStatus:'NOT_PROVIDED',captionsKnownPresent:false,sourceTrustTier:'PUBLIC_PLATFORM_METADATA',contentAuthority:'UNTRUSTED_EXTERNAL_DATA',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'}],
  safety:SAFETY,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE',
} as const;
const MISSING_VIDEO_EVIDENCE={ok:false,available:false,dataState:'UNKNOWN',reason:'SANITIZED_RUNTIME_EVIDENCE_MISSING',provider:'YOUTUBE_DATA_API_V3',providerAccess:'OFFICIAL_PUBLIC_API',requestMode:'READ_ONLY_GET',credentialValueExposed:false,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'} as const;
function fulfill(route:Route,body:unknown,status=200){return route.fulfill({status,contentType:'application/json; charset=utf-8',body:JSON.stringify(body)});}
async function installRuntime(page:Page,videoEvidence:unknown=MEASURED_VIDEO_EVIDENCE,videoEvidenceAuth:string[]=[]){
  await page.addInitScript(({authKey,user})=>{const enc=(v:Record<string,unknown>)=>btoa(JSON.stringify(v)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');const exp=4_102_444_800;const token=`${enc({alg:'none',typ:'JWT'})}.${enc({sub:user,role:'authenticated',exp})}.e2e`;localStorage.setItem(authKey,JSON.stringify({access_token:token,refresh_token:'video-research-refresh',expires_in:3600,expires_at:exp,token_type:'bearer',user:{id:user,aud:'authenticated',role:'authenticated',email:'video-research@accounts.invalid',app_metadata:{provider:'email',providers:['email']},user_metadata:{display_name:'연구 관리자'},identities:[],created_at:'2026-09-12T00:00:00.000Z'}}));},{authKey:AUTH_KEY,user:USER});
  await page.route('**/__e2e-supabase/**',async route=>{const pathname=new URL(route.request().url()).pathname;if(pathname.endsWith('/rest/v1/profiles'))return fulfill(route,{id:USER,login_name:'video-research-admin',display_name:'연구 관리자',role:'admin',status:'approved',membership_level:'admin',is_active:true,permissions_updated_at:'2026-09-12T00:00:00.000Z',updated_at:'2026-09-12T00:00:00.000Z'});if(pathname.endsWith('/auth/v1/user'))return fulfill(route,{id:USER,aud:'authenticated',role:'authenticated',email:'video-research@accounts.invalid',app_metadata:{},user_metadata:{}});return fulfill(route,{ok:true});});
  await page.route('**/api/**',async route=>{const pathname=new URL(route.request().url()).pathname;if(pathname==='/api/research/video/evidence'){videoEvidenceAuth.push(route.request().headers().authorization??'');return fulfill(route,videoEvidence);}if(pathname==='/api/admin/research/overview')return fulfill(route,{schemaVersion:'research-dashboard-overview-v1',generatedAt:Date.now(),state:{present:true,latestCycleAt:Date.now()},safety:{readOnlyDashboard:true,liveTrading:false,privateApi:false,orderAuthority:false,authorityEvidenceComplete:true,forbiddenAuthorityObserved:false},research:{status:'collecting',failedTasks:0,blockedDataTasks:0,cycles:[]},paper:{runtime:{present:true,status:'collecting',safetyEvidenceComplete:true,lanes:[],privateRequestCount:0,financialMutationCount:0,orderCount:0,liveTrading:false,orderAuthority:false},ledger:{present:true,cycleCount:0,sampleCount:0,positionCount:0,settlementCount:0}},shadow:{groups:[],records:{present:true,totalRecords:0,settledRecords:0,pendingRecords:0}},profitability:{proven:false,status:'NOT_PROVEN',note:'검증 중'}});return fulfill(route,{ok:true,items:[],rows:[],results:[]});});
}

for(const viewport of [{width:320,height:740},{width:1440,height:900}]){
  test(`video research reads sanitized runtime evidence and stays responsive at ${viewport.width}px`,async({page})=>{
    const providerRequests:string[]=[];const videoEvidenceAuth:string[]=[];page.on('request',request=>{if(request.url().includes('googleapis.com/youtube'))providerRequests.push(request.url());});
    await page.setViewportSize(viewport);await installRuntime(page,MEASURED_VIDEO_EVIDENCE,videoEvidenceAuth);await page.goto('/research-center');
    await expect(page.getByRole('button',{name:'전문가 보기',exact:true})).toHaveAttribute('aria-pressed','true');
    for(const name of ['일반 보기','전문가 보기','AI Research Copilot','영상 연구'])await expect(page.getByRole('button',{name,exact:true})).toBeVisible();
    await page.getByRole('button',{name:'영상 연구',exact:true}).click();
    const panel=page.getByTestId('research-video-panel');await expect(panel).toBeVisible();

    await expect(panel).toContainText('Research Source Only');
    await expect(panel).toContainText('MEASURED · sanitized reader connected · 1 source');
    await expect(panel).toContainText('YOUTUBE_DATA_API_V3 / READ_ONLY_GET');
    await expect(panel).toContainText('OFFICIAL_PUBLIC_API / READ_ONLY_GET');
    await expect(panel).toContainText('NOT_EXPOSED');
    await expect(panel).toContainText('SUCCESS · TEST_ONLY swing strategy');
    await expect(panel).toContainText('BOUNDED_ESTIMATE_USED_100_UNITS');
    await expect(panel).toContainText('UNKNOWN — transcript NOT_PROVIDED; segment count not measured');
    await expect(panel).toContainText('UNKNOWN_TIMESTAMP');
    await expect(panel).toContainText('NOT_EVALUATED');
    await expect(panel).not.toContainText('PROVIDER_NOT_CONFIGURED');

    for(const id of ['video-discovery-state','video-transcript-state','video-strategy-state','video-evidence-state','video-validation-state','video-detail-empty-state','video-cluster-empty-state'])await expect(page.getByTestId(id)).toBeVisible();
    for(const label of ['FACT','CREATOR CLAIM','AI INFERENCE','UNKNOWN','CONTRADICTED'])await expect(page.getByTestId('video-truth-legend')).toContainText(label);

    const strategy=page.getByTestId('video-strategy-state');
    await expect(strategy).toContainText('Strategy mining');
    await expect(strategy).toContainText('BLOCKED_TRANSCRIPT_NOT_PROVIDED — authorized transcript required; no caption bypass');
    const validation=page.getByTestId('video-validation-state');
    await expect(validation).toContainText('BLOCKED — authorized transcript required before strategy extraction/compiler');

    const evidence=page.getByTestId('video-evidence-state');
    await expect(evidence).toContainText('Video sources');
    await expect(evidence).toContainText('1 — measured sanitized public-provider result');
    await expect(evidence).not.toContainText('Video sources0');
    await expect(page.getByTestId('video-detail-empty-state')).toContainText('TEST_ONLY sanitized research source');
    await expect(page.getByTestId('video-detail-empty-state')).toContainText('TEST_ONLY channel');
    await expect(page.getByTestId('video-detail-empty-state')).toContainText('NOT_PROVIDED');
    await expect(page.getByTestId('video-detail-empty-state')).toContainText('BLOCKED_TRANSCRIPT_NOT_PROVIDED');
    await expect(page.getByTestId('video-detail-empty-state')).toContainText('UNTRUSTED_EXTERNAL_DATA');
    await expect(page.getByTestId('video-cluster-empty-state')).toContainText('cluster count는 0으로 만들지 않고 UNKNOWN으로 유지');
    await expect(panel).toContainText('Economic Evidence');await expect(panel).toContainText('Profitability Credit');await expect(panel).toContainText('Execution Authority');await expect(panel).toContainText('NONE');
    await expect(panel).toContainText('Independent source count는 경제적 표본 N이 아닙니다');
    await expect(page.getByTestId('video-phase2-safety-footer')).toContainText('Automatic discovery OFF');
    await expect(page.getByTestId('video-phase2-safety-footer')).toContainText('Schedule OFF');
    await expect(page.getByTestId('video-phase2-safety-footer')).toContainText('Economic Evidence Credit 0');
    expect(videoEvidenceAuth.length).toBeGreaterThan(0);expect(videoEvidenceAuth.at(-1)).toMatch(/^Bearer\s+\S+/u);expect(providerRequests).toEqual([]);

    const overflow=await page.evaluate(()=>Math.max(document.documentElement.scrollWidth,document.body.scrollWidth)-window.innerWidth);expect(overflow).toBeLessThanOrEqual(2);
  });
}

test('video research keeps missing sanitized snapshot UNKNOWN instead of measured zero',async({page})=>{
  const videoEvidenceAuth:string[]=[];await page.setViewportSize({width:1440,height:900});await installRuntime(page,MISSING_VIDEO_EVIDENCE,videoEvidenceAuth);await page.goto('/research-center');
  await page.getByRole('button',{name:'영상 연구',exact:true}).click();
  const panel=page.getByTestId('research-video-panel');await expect(panel).toBeVisible();
  await expect(panel).toContainText('UNKNOWN — sanitized runtime snapshot unavailable');
  const strategy=page.getByTestId('video-strategy-state');
  await expect(strategy).toContainText('UNKNOWN — strategy mining evidence missing != 0');
  const evidence=page.getByTestId('video-evidence-state');
  await expect(evidence).toContainText('UNKNOWN — missing runtime snapshot != 0');
  await expect(evidence).not.toContainText('Video sources0');
  await expect(page.getByTestId('video-detail-empty-state')).toContainText('0으로 단정하지 않고 UNKNOWN으로 유지');
  await expect(page.getByTestId('video-cluster-empty-state')).toContainText('missing을 0으로 만들지 않습니다');
  await expect(panel).toContainText('Economic Evidence');await expect(panel).toContainText('Profitability Credit');await expect(panel).toContainText('Execution Authority');await expect(panel).toContainText('NONE');
  expect(videoEvidenceAuth.length).toBeGreaterThan(0);expect(videoEvidenceAuth.at(-1)).toMatch(/^Bearer\s+\S+/u);
});
