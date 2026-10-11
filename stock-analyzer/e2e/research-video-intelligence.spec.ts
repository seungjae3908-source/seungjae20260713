import { expect, test, type Page } from '@playwright/test';

// Synthetic provider responses only. No actual YouTube call or caption access.
const USER='99999999-9999-4999-8999-999999999999';
const PROFILE={id:USER,login_name:'video-test-admin',display_name:'검증용 관리자',role:'admin',status:'approved',membership_level:'admin',is_active:true,permissions_updated_at:'2026-10-08T00:00:00.000Z'};
const safety={researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE',paidProviderEnabled:false,scheduleActive:false,automaticDiscoveryEnabled:false,liveTrading:false,privateTradingApi:false,realOrderEnabled:false,credentialMutation:false,transcriptDownloadEnabled:false};
const row={videoId:'TEST_ONLY_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=TEST_ONLY_VIDEO',title:'TEST_ONLY source',channelOrPublisher:'TEST_ONLY channel',publishedAt:'2026-09-12T00:00:00.000Z',discoveredAt:'2026-09-13T00:00:00.000Z',language:'ko',durationSec:321,transcriptStatus:'NOT_PROVIDED',captionsKnownPresent:false,sourceTrustTier:'UNKNOWN',contentAuthority:'UNTRUSTED_EXTERNAL_DATA',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
const automation={schemaVersion:'research-video-discovery-scan-v1',status:'COMPLETE',observedAt:'2026-10-02T03:00:00.000Z',researchSha:'a'.repeat(40),query:'TEST_ONLY research',sourceCount:1,snapshotDigest:'b'.repeat(64),providerNetworkCalls:1,invocationMode:'SYSTEMD_TIMER',scheduledInvocationObserved:true,reason:null,nextRequiredStep:'SOURCE_REVIEW_THEN_EXISTING_GEMINI_GROQ_ORCHESTRATOR',snapshotBound:true};
const aiReview={status:'COMPLETE',observedAt:Date.parse('2026-10-02T03:00:30.000Z'),researchSha:'a'.repeat(40),provider:'groq',model:'openai/gpt-oss-20b',reason:'CONFIGURED_FREE_ONLY_QUOTA_UNKNOWN',providerNetworkCalls:1,cacheHits:0,reviewCount:1,proposerReviewCount:0,criticReviewCount:1,missingProfileCount:0,blockedProfileCount:0,deferredProfileCount:0,invocationMode:'SYSTEMD_TIMER',scheduledInvocationObserved:true};
const evidence={ok:true,available:true,dataState:'MEASURED',runtimeVersion:'video-research-public-provider-runtime-v3',status:'SUCCESS',provider:'YOUTUBE_DATA_API_V3',providerAccess:'OFFICIAL_PUBLIC_API',requestMode:'READ_ONLY_GET',query:'TEST_ONLY research',pagesUsed:1,quotaState:'BOUNDED_ESTIMATE_USED_100_UNITS',credentialConfigured:true,credentialValueExposed:false,sourceCount:1,records:[row],safety,snapshotProvenance:{schemaVersion:'video-research-sanitized-snapshot-v1',sourceHeadSha:'a'.repeat(40),observedAt:'2026-09-13T00:00:00.000Z',publisherMode:'LOCAL_ATOMIC_FILE',providerRuntimeVersion:'video-research-public-provider-runtime-v3',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'},automation,aiReview,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
async function install(page:Page,payload:unknown){
  const calls:Array<{method:string;auth:boolean}>=[],external:string[]=[],errors:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  page.on('request',r=>{if(/googleapis\.com\/youtube|generativelanguage|api\.groq/.test(r.url()))external.push(r.url());});
  await page.addInitScript(user=>{
    const enc=(v:Record<string,unknown>)=>btoa(JSON.stringify(v)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
    const token=`${enc({alg:'none',typ:'JWT'})}.${enc({sub:user,role:'authenticated',exp:4102444800})}.e2e`;
    localStorage.setItem('sb-127-auth-token',JSON.stringify({access_token:token,refresh_token:'TEST_ONLY',expires_in:3600,expires_at:4102444800,token_type:'bearer',user:{id:user,aud:'authenticated',role:'authenticated',email:'test@accounts.invalid',app_metadata:{provider:'email',providers:['email']},user_metadata:{},identities:[],created_at:'2026-09-12T00:00:00.000Z'}}));
  },USER);
  await page.route('**/__e2e-supabase/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    await route.fulfill({contentType:'application/json',body:JSON.stringify(path.endsWith('/rest/v1/profiles')?PROFILE:path.endsWith('/auth/v1/user')?{id:USER,aud:'authenticated',role:'authenticated',email:'test@accounts.invalid'}:{ok:true})});
  });
  await page.route('**/api/**',async route=>{
    const r=route.request(),path=new URL(r.url()).pathname;
    let body:unknown={ok:true,items:[],rows:[],results:[]};
    if(path==='/api/auth/profile')body=PROFILE;
    if(path==='/api/research/video/evidence'){calls.push({method:r.method(),auth:Boolean(r.headers().authorization)});body=payload;}
    if(path==='/api/research/video/evidence/workspace')body={available:false,reason:'TEST_ONLY_NO_STORE'};
    await route.fulfill({contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('/research-center');
  await expect(page.getByRole('button',{name:'요약',exact:true})).toHaveAttribute('aria-pressed','true');
  await page.getByRole('button',{name:'영상',exact:true}).click();
  const panel=page.getByTestId('research-video-panel');await expect(panel).toBeVisible();
  return {panel,calls,external,errors};
}
for(const width of [320,1440]){
  test(`source reader preserves measured provenance at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});const h=await install(page,evidence);
    await expect(page.getByTestId('video-source-count')).toContainText('1개');
    for(const id of ['video-source-count','video-discovery-state','video-validation-state','video-review-count'])await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('video-detail-record-0')).toContainText('TEST_ONLY source');
    await expect(page.getByTestId('video-detail-record-0')).toContainText('전사본 없음');
    await expect(page.getByTestId('video-detail-record-0')).toContainText('사용 가능한 전사본 필요');
    await expect(page.getByTestId('video-discovery-state')).toContainText('자동 실행 확인');
    await expect(page.getByTestId('video-validation-state')).toContainText('검토 기록 있음');
    await expect(page.getByTestId('video-review-count')).toContainText('1건');
    await page.getByText('수집·분석 기록',{exact:true}).click();
    await expect(h.panel).toContainText('aaaaaaaaaaaa');
    await expect(h.panel).toContainText('0 / 1');
    await expect(h.panel).toContainText('수익성 증거로 사용하지 않음');
    expect(h.calls.length).toBeGreaterThan(0);expect(h.calls.every(x=>x.method==='GET'&&x.auth)).toBe(true);
    expect(h.external).toEqual([]);expect(h.errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(2);
  });
  test(`source reader retains mixed per-video evidence at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    const records=['NOT_AUTHORIZED','UNAVAILABLE','NOT_PROVIDED'].map((status,i)=>({...row,videoId:`TEST_${i}`,canonicalUrl:`https://www.youtube.com/watch?v=TEST_${i}`,title:`TEST source ${i}`,transcriptStatus:status}));
    await install(page,{...evidence,sourceCount:3,records});
    for(let i=0;i<3;i++)await expect(page.getByTestId(`video-detail-record-${i}`)).toContainText(records[i].transcriptStatus);
    await expect(page.getByTestId('video-source-count')).toContainText('3개');
    await expect(page.getByTestId('video-detail-record-0')).toContainText('전사본 사용 권한 필요');
  });
}
test('missing source stays unknown while safe AI status remains visible',async({page})=>{
  const waitingAutomation={...automation,status:'WAITING_CONFIGURATION',query:null,sourceCount:null,snapshotDigest:null,providerNetworkCalls:0,scheduledInvocationObserved:false,reason:'YOUTUBE_PROVIDER_NOT_CONFIGURED',nextRequiredStep:'CONFIGURE_APPROVED_READ_ONLY_YOUTUBE_DISCOVERY',snapshotBound:false};
  const {panel}=await install(page,{available:false,dataState:'UNKNOWN',reason:'VIDEO_RESEARCH_SNAPSHOT_MISSING',automation:waitingAutomation,aiReview});
  await expect(page.getByTestId('video-source-count')).toContainText('미확인');
  await expect(page.getByTestId('video-source-count')).not.toContainText('0개');
  await expect(panel).toContainText('설정·자료 확인 필요');
  await expect(page.getByTestId('video-review-count')).toContainText('1건');
  await expect(panel).toContainText('영상 수집 결과를 아직 확인하지 못했습니다');
});
test('automation from a different snapshot lineage never proves current timer execution',async({page})=>{
  const unbound={...evidence,automation:{...automation,snapshotBound:false}};
  await install(page,unbound);
  await expect(page.getByTestId('video-discovery-state')).toContainText('기록 연결 확인 필요');
  await expect(page.getByTestId('video-discovery-state')).not.toContainText('자동 실행 확인');
});
test('malformed provenance cannot become measured',async({page})=>{
  const {panel}=await install(page,{...evidence,snapshotProvenance:{...evidence.snapshotProvenance,sourceHeadSha:'invalid'}});
  await expect(page.getByTestId('video-source-count')).toContainText('미확인');
  await expect(page.getByTestId('video-detail-record-0')).toHaveCount(0);
  await expect(panel).toContainText('영상 수집 결과를 아직 확인하지 못했습니다');
});

test('a successful empty AI scan never becomes a completed source analysis',async({page})=>{
  await install(page,{...evidence,aiReview:{...aiReview,reviewCount:0,criticReviewCount:0,providerNetworkCalls:0}});
  await expect(page.getByTestId('video-validation-state')).toContainText('분석기 실행 · 검토 0건');
  await expect(page.getByTestId('video-validation-state')).not.toContainText('검토 기록 있음');
});
