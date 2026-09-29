import { expect, test, type Page } from '@playwright/test';

// Synthetic provider responses only. No actual YouTube call or caption access.
const USER='99999999-9999-4999-8999-999999999999';
const PROFILE={id:USER,login_name:'video-test-admin',display_name:'검증용 관리자',role:'admin',status:'approved',membership_level:'admin',is_active:true};
const safety={researchOnly:true,economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE',paidProviderEnabled:false,scheduleActive:false,automaticDiscoveryEnabled:false,liveTrading:false,privateTradingApi:false,realOrderEnabled:false,credentialMutation:false,transcriptDownloadEnabled:false};
const row={videoId:'TEST_ONLY_VIDEO',canonicalUrl:'https://www.youtube.com/watch?v=TEST_ONLY_VIDEO',title:'TEST_ONLY source',channelOrPublisher:'TEST_ONLY channel',publishedAt:'2026-09-12T00:00:00.000Z',discoveredAt:'2026-09-13T00:00:00.000Z',language:'ko',durationSec:321,transcriptStatus:'NOT_PROVIDED',captionsKnownPresent:false,sourceTrustTier:'UNKNOWN',contentAuthority:'UNTRUSTED_EXTERNAL_DATA',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
const evidence={ok:true,available:true,dataState:'MEASURED',runtimeVersion:'video-research-public-provider-runtime-v3',status:'SUCCESS',provider:'YOUTUBE_DATA_API_V3',providerAccess:'OFFICIAL_PUBLIC_API',requestMode:'READ_ONLY_GET',query:'TEST_ONLY research',pagesUsed:1,quotaState:'BOUNDED_ESTIMATE_USED_100_UNITS',credentialConfigured:true,credentialValueExposed:false,sourceCount:1,records:[row],safety,snapshotProvenance:{schemaVersion:'video-research-sanitized-snapshot-v1',sourceHeadSha:'a'.repeat(40),observedAt:'2026-09-13T00:00:00.000Z',publisherMode:'LOCAL_ATOMIC_FILE',providerRuntimeVersion:'video-research-public-provider-runtime-v3',economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'},economicEvidenceCredit:0,profitabilityCredit:0,executionAuthority:'NONE'};
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
  await page.getByText('기술 상태 자세히 보기',{exact:true}).click();
  const panel=page.getByTestId('research-video-panel');await expect(panel).toBeVisible();
  return {panel,calls,external,errors};
}
for(const width of [320,1440]){
  test(`source reader preserves measured provenance at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});const h=await install(page,evidence);
    await expect(h.panel).toContainText('MEASURED · sanitized reader connected · 1 source');
    for(const id of ['video-discovery-state','video-transcript-state','video-strategy-state','video-evidence-state','video-validation-state'])await expect(page.getByTestId(id)).toBeVisible();
    await expect(page.getByTestId('video-detail-record-0')).toContainText('TEST_ONLY source');
    await expect(page.getByTestId('video-strategy-state')).toContainText('BLOCKED_TRANSCRIPT_NOT_PROVIDED');
    await expect(page.getByTestId('video-evidence-state')).toContainText('aaaaaaaaaaaa');
    for(const word of ['FACT','CREATOR CLAIM','AI INFERENCE','UNKNOWN','CONTRADICTED'])await expect(page.getByTestId('video-truth-legend')).toContainText(word);
    await expect(page.getByTestId('video-phase2-safety-footer')).toContainText('Schedule OFF');
    expect(h.calls.length).toBeGreaterThan(0);expect(h.calls.every(x=>x.method==='GET'&&x.auth)).toBe(true);
    expect(h.external).toEqual([]);expect(h.errors).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth-innerWidth)).toBeLessThanOrEqual(2);
  });
  test(`source reader retains mixed per-video evidence at ${width}px`,async({page})=>{
    await page.setViewportSize({width,height:900});
    const records=['NOT_AUTHORIZED','UNAVAILABLE','NOT_PROVIDED'].map((status,i)=>({...row,videoId:`TEST_${i}`,canonicalUrl:`https://www.youtube.com/watch?v=TEST_${i}`,title:`TEST source ${i}`,transcriptStatus:status}));
    await install(page,{...evidence,sourceCount:3,records});
    for(let i=0;i<3;i++)await expect(page.getByTestId(`video-detail-record-${i}`)).toContainText(records[i].transcriptStatus);
    await expect(page.getByTestId('video-transcript-state')).toContainText('MULTI_SOURCE');
  });
}
test('missing source stays unknown, not a measured zero',async({page})=>{
  const {panel}=await install(page,{available:false,dataState:'UNKNOWN'});
  await expect(panel).toContainText('UNKNOWN — sanitized runtime snapshot unavailable');
  await expect(page.getByTestId('video-evidence-state')).toContainText('UNKNOWN — missing runtime snapshot != 0');
  await expect(page.getByTestId('video-cluster-empty-state')).toContainText('missing을 0으로 만들지 않습니다');
});
test('malformed provenance cannot become measured',async({page})=>{
  const {panel}=await install(page,{...evidence,snapshotProvenance:{...evidence.snapshotProvenance,sourceHeadSha:'invalid'}});
  await expect(panel).not.toContainText('MEASURED · sanitized reader connected');
  await expect(panel).toContainText('UNKNOWN — sanitized runtime snapshot unavailable');
});
