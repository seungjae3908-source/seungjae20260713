#!/usr/bin/env node
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {ARMS,POLICY,START,END,duration,validateCandles,evaluateArm} from '../src/selective-opportunity-audit-v2.mjs';
const out=resolve(process.argv[2]??'docs/selective-opportunity-audit-v2');
const sha256=x=>createHash('sha256').update(x).digest('hex');
const save=async(name,obj)=>writeFile(`${out}/${name}`,JSON.stringify(obj,null,2)+'\n','utf8');
async function baselineModule(){
  const file=new URL('./run-selective-opportunity-6m-v1.js',import.meta.url),buf=await readFile(file);
  const blob=createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
  if(blob!=='d067756b29de71a4ddc0a9e51a1854eb0149cbc4')throw new Error('FROZEN_V1_SOURCE_CHANGED');
  let s=buf.toString('utf8');const end=s.lastIndexOf('\nmain().catch(');
  if(end<0)throw new Error('FROZEN_V1_ENTRYPOINT_NOT_FOUND');
  s=s.slice(0,end);
  for(const relative of ['../src/yahoo-stock-history.js','../src/upbit-spot-history.js'])s=s.replaceAll(`'${relative}'`,`'${new URL(relative,import.meta.url).href}'`);
  s+='\nexport {KR_THEMES,US_THEMES,CRYPTO_THEMES,US_EXPLOSION_SYMBOLS,collectStocks,collectCrypto,evaluateThemeLane,evaluateUsExplosion,compactLane};\n';
  // Load a checksum-pinned copy without calling V1 main; V1 repository bytes are untouched.
  return {module:await import(`data:text/javascript;base64,${Buffer.from(s).toString('base64')}`),blob,sourceSha256:sha256(buf)};
}
const pct=x=>Number.isFinite(x)?(100*x).toFixed(3):'NA';
function compact(p){return {acceptedTrades:p.acceptedTrades,candidateTrades:p.candidateTrades,rejectedTrades:p.rejectedTrades,
  netReturn:p.netReturn,barSampledMtmMaxDrawdown:p.barSampledMtmMaxDrawdown,metrics:p.metrics,totalFees:p.totalFees,
  initialCapital:p.initialCapital,maxGrossObserved:p.maxGrossObserved,minCash:p.minCash,monthly:p.monthly};}
function render(result){
  const lines=['# Selective Opportunity V2 — matched-candidate diagnostic audit','',
    '2026-03-25 ~ 2026-09-24. 이미 관찰한 구간의 사후 연구이며 OOS/실거래 수익률이 아닙니다.',
    'V1 후보 진입 목록 고정. 신규 진입/재진입 탐색은 포함하지 않습니다. 모든 비교군은 같은 원본 캔들과 동일한 현금·종목·테마·위험 제한을 사용합니다.',
    '', '| 시장 | 비교군 | 수용 거래 | 승률 | 모형 순수익 | 봉 시가·종가 평가 MDD | 비용 1.5배 |',
    '|---|---|---:|---:|---:|---:|---:|'];
  for(const a of result.summary)lines.push(`| ${a.lane} | ${a.arm} | ${a.normal.acceptedTrades} | ${pct(a.normal.metrics.winRate)}% | ${pct(a.normal.netReturn)}% | ${pct(a.normal.barSampledMtmMaxDrawdown)}% | ${pct(a.stress.netReturn)}% |`);
  lines.push('','## 제한',
    '- 첫 V1 실행은 원본 캔들을 보관하지 않았습니다. 이번 원본은 별도로 저장·해시 처리하며 당시 원본과 동일하다고 단정하지 않습니다.',
    '- BASELINE_ACCOUNTING에도 모든 비교군 공통의 현금·중복·테마·위험 제한이 적용됩니다. 예전 수익률과의 차이를 전략 효과 또는 계산 오류 효과 하나로 단정하지 않습니다.',
    '- 주식 최초 수량은 정수 주, 분할청산은 비율 모형입니다. 거래단위/부분체결/거래정지/호가 깊이 및 법적 결제일은 정밀 재현하지 못합니다.',
    '- 갭하락은 손절가보다 나쁜 시가로 계산합니다. 손절 상한은 손실 보장이 아닙니다.',
    '- MDD는 관측 봉 시가·종가 평가액 기준입니다. 봉 내부 최고 낙폭과 같지 않습니다.',
    '- 국내/미국/코인별 표시통화 계좌를 별도로 계산합니다. 환율·시장간 중복자산 배분 검증 전 통합 수익률은 제공하지 않습니다.',
    '- 과거 테마 편입, 상폐 종목, 뉴스/공시, 유통주식·희석위험의 PIT 자료는 미충족입니다.',
    '- AI 확률, 비용 차감 미래 기대값, 수익성 승격, Paper 활성화, 텔레그램 전송은 허용하지 않습니다.',
    '',`Snapshot SHA256: ${result.sourceSnapshotSha256}`,`Policy SHA256: ${result.policySha256}`,
    `Decision: ${result.decision}`,'');return lines.join('\n');
}
async function main(){
  await mkdir(out,{recursive:true});
  const loaded=await baselineModule(),v=loaded.module;
  const startedAt=new Date().toISOString();
  const policySha256=sha256(JSON.stringify(POLICY));
  await save('preregistration.json',{startedAt,policy:POLICY,arms:ARMS,policySha256,baselineBlob:loaded.blob,
    baselineSourceSha256:loaded.sourceSha256,originalRunId:36083104372,originalInputSnapshotArchived:false,
    resultsInspectedBeforeThisPolicy:true,gridSearch:false,pristineHistoricalOos:false,
    nextUnseenEvaluation:'FUTURE_AFTER_NEW_POLICY_FREEZE_AND_DATA_APPROVAL',activation:false});
  const requested={
    kr:[...new Set(['069500',...v.KR_THEMES.flatMap(t=>t.symbols)])],
    us:[...new Set(['SPY',...v.US_THEMES.flatMap(t=>t.symbols),...v.US_EXPLOSION_SYMBOLS])],
    crypto:[...new Set(v.CRYPTO_THEMES.flatMap(t=>t.symbols))],
  };
  let snapshot;
  const reuse=process.argv.find(x=>x.startsWith('--snapshot='));
  if(reuse){snapshot=JSON.parse(await readFile(resolve(reuse.slice(11)),'utf8'));}
  else{
    const [kr,us,crypto]=await Promise.all([v.collectStocks('KR_STOCK',requested.kr),v.collectStocks('US_STOCK',requested.us),v.collectCrypto(requested.crypto)]);
    snapshot={schemaVersion:1,collectedAt:new Date().toISOString(),window:[START,END],
      sources:{stocks:'Yahoo public chart 1d',crypto:'Upbit KRW public 4h'},requested,
      lanes:Object.fromEntries(Object.entries({kr,us,crypto}).map(([k,x])=>[k,{data:Object.fromEntries(x.data),failures:x.failures}]))};
  }
  if(JSON.stringify(snapshot.window)!==JSON.stringify([START,END]))throw new Error('SNAPSHOT_WINDOW_MISMATCH');
  const raw=JSON.stringify(snapshot);const sourceSnapshotSha256=sha256(raw);
  await writeFile(`${out}/source-snapshot.json`,raw,'utf8');
  const maps={},integrity={};
  for(const [key,lane] of Object.entries({kr:'KR_STOCK',us:'US_STOCK',crypto:'CRYPTO_SPOT'})){
    maps[key]=new Map();integrity[key]={failures:snapshot.lanes[key].failures,accepted:[],blocked:[]};
    for(const [symbol,rows] of Object.entries(snapshot.lanes[key].data)){
      try{
        const check=validateCandles(rows,lane),evalRows=rows.filter(r=>r.timestamp>=START);
        if(check.first>START||!evalRows.length||check.last<END-4*86400000)throw new Error('FULL_WINDOW_COVERAGE_INSUFFICIENT');
        // Upbit may omit no-trade intervals. Do not invent bars or call missing path data complete.
        const gaps=lane==='CRYPTO_SPOT'?evalRows.slice(1).filter((r,i)=>r.timestamp-evalRows[i].timestamp!==duration(lane)).length:0;
        if(gaps>0)throw new Error(`CRYPTO_PATH_GAPS_${gaps}`);
        maps[key].set(symbol,rows);integrity[key].accepted.push({symbol,...check,sourceSha256:sha256(JSON.stringify(rows))});
      }catch(e){integrity[key].blocked.push({symbol,reason:e.message});}
    }
  }
  await save('source-integrity.json',integrity);
  const stockConfig={fastBars:20,slowBars:60,momentumBars:20,longMomentumBars:60,highLookback:20,pullbackMin:.02,pullbackMax:.10,
    themeAlphaMinimum:.02,maxOverextension:.08,stopAtr:2.5,trailAtr:3,maxHoldBars:40};
  const cryptoConfig={fastBars:30,slowBars:120,momentumBars:30,longMomentumBars:90,highLookback:30,pullbackMin:.03,pullbackMax:.15,
    themeAlphaMinimum:.03,maxOverextension:.12,stopAtr:2.7,trailAtr:3.2,maxHoldBars:90};
  const specs=[
    {lane:'KR_STOCK',key:'kr',themes:v.KR_THEMES,benchmark:'069500',cost:.0025,config:stockConfig},
    {lane:'US_STOCK',key:'us',themes:v.US_THEMES,benchmark:'SPY',cost:.0015,config:stockConfig},
    {lane:'US_EXPLOSION_DAILY_PROXY',key:'us',themes:[],benchmark:'SPY',cost:.005,explosion:true},
    {lane:'CRYPTO_SPOT',key:'crypto',themes:v.CRYPTO_THEMES,benchmark:'BTC',cost:.0015,config:cryptoConfig},
  ];
  const baselines=[],arms=[],blockedLanes=[];
  for(const spec of specs){
    try{
      const data=maps[spec.key];
      const base=spec.explosion?v.evaluateUsExplosion({data,benchmarkSymbol:spec.benchmark}):v.evaluateThemeLane({market:spec.lane,themes:spec.themes,data,benchmarkSymbol:spec.benchmark,costs:spec.cost,config:spec.config});
      baselines.push({lane:spec.lane,legacyRecalculation:v.compactLane(base),candidateDigest:sha256(JSON.stringify(base.trades)),trades:base.trades});
      for(const arm of ARMS)arms.push(evaluateArm(base.trades,data,spec.themes,spec.lane,arm,spec.cost));
    }catch(e){blockedLanes.push({lane:spec.lane,error:e.message});}
  }
  await save('legacy-on-this-snapshot.json',baselines);
  await save('detailed-results.json',arms);
  const result={schemaVersion:2,researchCodeSha:process.env.RESEARCH_CODE_SHA??null,generatedAt:new Date().toISOString(),
    policy:POLICY,policySha256,sourceSnapshotSha256,baselineSourceSha256:loaded.sourceSha256,integrity,blockedLanes,
    summary:arms.map(a=>({arm:a.arm,lane:a.lane,fixedCandidateCount:a.fixedCandidateCount,eligibleCandidates:a.eligibleCandidates,
      blockers:a.blockers,normal:compact(a.normal),stress:compact(a.stress),byTheme:a.byTheme})),
    combinedReturn:null,combinedReturnReason:'FX_AND_CROSS_SLEEVE_GLOBAL_RISK_NOT_MODELED',
    decision:'RESEARCH_HOLD_NO_PRISTINE_OOS',canonicalSampleDelta:0,profitabilityProven:false,executionAuthority:'NONE',actualOrders:0};
  if(!arms.length)throw new Error('ALL_LANES_DATA_BLOCKED');
  await save('result.json',result);await writeFile(`${out}/result.md`,render(result),'utf8');
  await save('provenance.json',{researchCodeSha:result.researchCodeSha,sourceSnapshotSha256,policySha256,
    resultSha256:sha256(await readFile(`${out}/result.json`)),originalRunId:36083104372,
    originalResultPreserved:true,baselineSourceUnchanged:true,branchWrite:false,privateApiAllowed:false,actualOrders:0,
    paperActivation:false,telegramSent:0,profitabilityProven:false,canonicalSampleDelta:0});
  console.log(render(result));
  if(blockedLanes.length)throw new Error('PARTIAL_LANE_FAILURE_SEE_RESULT');
}
main().catch(e=>{console.error(e.stack??e);process.exitCode=1;});
