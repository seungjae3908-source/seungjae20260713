import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTelegramMarketBriefInput, boundedTelegramBriefRead,
  type TelegramMarketBriefSnapshot,
} from './telegram-market-brief.service';
import { dueTelegramIntelligenceReports } from './telegram-intelligence-report.service';
import { renderTelegramAlert } from './telegram-notification.service';
import {
  collectTelegramBriefSignalStatus, telegramBriefSignalLines,
} from './telegram-brief-signal-status.service';

const leaders=Array.from({length:6},(_,i)=>({
  name:'관찰종목'+(i+1),symbol:'T'+(i+1),changePercent:2.5,
}));
const news={
  id:'safe-news',kind:'news',symbol:'T1',title:'검증된 뉴스 제목',summary:'근거 있는 기사 요약입니다.',
  provider:'검증출처',source:'검증출처',url:'https://example.org/story',publishedAt:'2026-10-09T00:00:00Z',
};
const disclosure={
  ...news,id:'safe-disclosure',kind:'disclosure',symbol:'T2',title:'기업 공시 발표',
  summary:null,url:'https://example.org/disclosure',
};
const snapshot={
  generatedAt:'2026-10-09T00:00:00Z',
  rooms:[{room:'stocks-kr',error:null,response:{
    partial:false,sections:{
      indices:{status:'ready',data:[
        {label:'KOSPI',value:3000,changePercent:1.0},
        {label:'KOSDAQ',value:900,changePercent:0.8},
      ]},
      rankings:{status:'ready',data:leaders},
      news:{status:'ready',data:[news]},
      disclosures:{status:'ready',data:[disclosure]},
      derivatives:{status:'empty',data:null},
      sectors:{status:'empty',data:[]},
    }
  }}],krThemes:null,usThemes:null,warnings:[],
} as unknown as TelegramMarketBriefSnapshot;
test('verified market brief separates sections, has up to five symbols and shows source summaries',()=>{
  const input=buildTelegramMarketBriefInput({
    kind:'MORNING',localDate:'2026-10-09',destination:'KR_STOCK_ROOM',
    destinationChatId:'room-kr',dedupeKey:'readable-brief',
    now:new Date('2026-10-09T00:00:00Z'),snapshot,
  });
  assert.match(input.details||'',/\[주요 지수\]\n• KOSPI/u);
  assert.match(input.details||'',/\[시장 주목 종목 TOP 5/u);
  assert.match(input.details||'',/5\. 관찰종목5/u);
  assert.doesNotMatch(input.details||'',/관찰종목6/u);
  assert.match(input.details||'',/시장 분위기: 상승 우위/u);
  assert.match(input.details||'',/기사 요약: 근거 있는 기사 요약입니다/u);
  assert.match(input.details||'',/\[공시\] 검증출처/u);
  assert.equal(input.buttons?.length,2);
});
test('weekly brief refuses to synthesize returns and gives an explicit unavailable state',()=>{
  const input=buildTelegramMarketBriefInput({
    kind:'WEEKLY',localDate:'2026-10-05',destination:'KR_STOCK_ROOM',
    destinationChatId:'room-kr',dedupeKey:'weekly',
    now:new Date('2026-10-05T00:00:00Z'),snapshot,
  });
  assert.match(input.details||'',/\[주간 성과\]\n1주 누적 수익률: N\/A/u);
});

test('a hung optional public theme or market-room source cannot stall Telegram scheduled delivery',async()=>{
  let reads=0;
  const never=await boundedTelegramBriefRead<string>(()=>{
    reads++;
    return new Promise<string>(()=>{});
  },15);
  assert.equal(never,null);
  assert.equal(reads,1);
  assert.equal(await boundedTelegramBriefRead(async()=> 'SAFE_PUBLIC_DATA',15),
    'SAFE_PUBLIC_DATA');
  assert.equal(await boundedTelegramBriefRead(async()=>{
    throw new Error('SECRET_TOKEN_IN_PROVIDER_MESSAGE');
  },15),null);
  assert.equal(await boundedTelegramBriefRead(async()=> 'unexpected',0),null);
});

test('brief title carries room, kind and KST date; footer shows KST time, not a raw UTC stamp',()=>{
  const input=buildTelegramMarketBriefInput({
    kind:'MORNING',localDate:'2026-10-18',destination:'CRYPTO_SPOT_ROOM',
    destinationChatId:'room-spot',dedupeKey:'title',
    now:new Date('2026-10-17T22:50:55.133Z'),snapshot:{...snapshot,rooms:[]},
  });
  assert.equal(input.title,'🪙 코인현물 아침 시황 · 10월 18일 (일)');
  assert.match(input.details||'',/기준 시각 10월 18일 \(일\) 07:50 \(한국 시간\)/u);
  assert.doesNotMatch(renderTelegramAlert(input),/2026-10-17T22:50/u);
});

test('spot TOP 5 drops stablecoins, repeated names collapse, delayed sections are named',()=>{
  const spot={
    ...snapshot,
    rooms:[{room:'coins-spot',error:null,response:{
      partial:true,sections:{
        indices:{status:'error',data:[]},
        rankings:{status:'ready',data:[
          {name:'테더',symbol:'USDT',changePercent:0.15},
          {name:'KRW-USDC',symbol:'KRW-USDC',changePercent:0.01},
          {name:'샌드박스',symbol:'SAND',changePercent:9.8},
          {name:'ETHUSDT',symbol:'ETHUSDT',changePercent:-1.13},
        ]},
        news:{status:'unavailable',data:[]},
        disclosures:{status:'empty',data:[]},
        derivatives:{status:'empty',data:null},
        sectors:{status:'empty',data:[]},
      },
    }}],
  } as unknown as TelegramMarketBriefSnapshot;
  const details=buildTelegramMarketBriefInput({
    kind:'MORNING',localDate:'2026-10-18',destination:'CRYPTO_SPOT_ROOM',
    destinationChatId:'room-spot',dedupeKey:'spot',now:new Date('2026-10-17T22:50:00Z'),snapshot:spot,
  }).details||'';
  assert.doesNotMatch(details,/USDT\)|USDC/u);
  assert.match(details,/1\. 샌드박스 \(SAND\) \+9\.80%/u);
  assert.match(details,/2\. ETHUSDT -1\.13%/u);
  assert.match(details,/⚠️ 확인 지연: 지수, 뉴스/u);
});

test('weekend KST morning skips stock rooms with no fresh session; crypto rooms still get the brief',()=>{
  const audience={membership:'admin' as const};
  const destinations=(iso:string)=>dueTelegramIntelligenceReports(new Date(iso),audience)
    .find(plan=>plan.kind==='MORNING')?.destinations;
  // Saturday 08:00 KST: KR closed, US Friday session just closed.
  assert.deepEqual(destinations('2026-10-16T23:00:00.000Z'),['US_STOCK_ROOM','CRYPTO_SPOT_ROOM','CRYPTO_FUTURES_ROOM']);
  // Sunday 08:00 KST: both stock markets closed since the last brief.
  assert.deepEqual(destinations('2026-10-17T23:00:00.000Z'),['CRYPTO_SPOT_ROOM','CRYPTO_FUTURES_ROOM']);
  // Monday 08:00 KST: KR opens; the US room waits for its Tuesday brief.
  assert.deepEqual(destinations('2026-10-18T23:00:00.000Z'),['KR_STOCK_ROOM','CRYPTO_SPOT_ROOM','CRYPTO_FUTURES_ROOM']);
  // Weekday: all four rooms.
  assert.deepEqual(destinations('2026-10-19T23:00:00.000Z'),['KR_STOCK_ROOM','US_STOCK_ROOM','CRYPTO_SPOT_ROOM','CRYPTO_FUTURES_ROOM']);
  const stockOnly=dueTelegramIntelligenceReports(new Date('2026-10-17T23:00:00.000Z'),
    {membership:'associate',includeCrypto:false});
  assert.equal(stockOnly.some(plan=>plan.kind==='MORNING'),false);
});


const ids=['KR','US','SPOT','FUTURES'].flatMap(m=>
  ['SCALPING_15M',m==='SPOT'?'SWING_4H':'SWING_60M','MID_LONG_1D'].map(x=>m+'_'+x));
function lane(laneId:string,status='VALID_NO_TRADE'){
  return {laneId,status,lastGoodPreserved:false,cursorRotatedBlockedOnly:false,universePartial:false,
    universeStale:false,responseDataState:'complete',providerErrors:0,timeouts:0,universeProviderErrors:0,
    cursorBefore:0,cursorAfter:40,totalUniverse:400,scannedCards:40,
    publicExecutionDiagnostic:{state:'PAGE_EXECUTION_COMPLETE',partial:false,timedOut:false,providerErrors:0,
      timeouts:0,failuresObserved:0,requested:40,started:40,completed:40}};
}
const ready=(coverage=ids.map(id=>lane(id)),events:unknown[]=[])=>
  ({status:'READY' as const,snapshot:{coverage,events,rows:[]}});

test('no candidate in a complete market reads as an explicit no-signal line with the scanned count',()=>{
  const lines=telegramBriefSignalLines(ready(),'KR_STOCK_ROOM');
  assert.deepEqual(lines,['','[신호 현황]','📭 국내주식 · 현재 새 신호 없음 (120종목 확인)']);
});

test('current candidates are counted per market, never named',()=>{
  const events=[
    {type:'NEW_CANDIDATE',market:'CRYPTO_FUTURES',id:'CRYPTO_FUTURES|BTCUSDT|S|60m|LONG'},
    {type:'RESCAN_REQUESTED',market:'CRYPTO_FUTURES',id:'CRYPTO_FUTURES|BTCUSDT|S|60m|LONG'},
    {type:'NEW_CANDIDATE',market:'CRYPTO_SPOT',id:'CRYPTO_SPOT|SAND|S|4H|BUY'},
  ];
  const futures=telegramBriefSignalLines(ready(undefined,events),'CRYPTO_FUTURES_ROOM').join('\n');
  assert.match(futures,/현재 진입 후보 1개 · 종목별 알림으로 따로 안내/u);
  assert.doesNotMatch(futures,/BTCUSDT|SAND/u);
  assert.match(telegramBriefSignalLines(ready(undefined,events),'US_STOCK_ROOM').join('\n'),/해외주식 · 현재 새 신호 없음/u);
});

test('blocked engine data or a missing engine never reads as "no signal"',()=>{
  const blocked=ids.map(id=>lane(id,id.startsWith('US_')?'BLOCKED_DATA':'VALID_NO_TRADE'));
  assert.match(telegramBriefSignalLines(ready(blocked),'US_STOCK_ROOM').join('\n'),/자료를 확인하는 중 · 판단 보류/u);
  assert.match(telegramBriefSignalLines({status:'UNAVAILABLE'},'KR_STOCK_ROOM').join('\n'),/신호 엔진 응답 없음/u);
  assert.match(telegramBriefSignalLines({status:'INVALID'},'KR_STOCK_ROOM').join('\n'),/확인되지 않아 판단 보류/u);
  for(const signal of [{status:'UNAVAILABLE' as const},{status:'INVALID' as const},ready(blocked)])
    assert.doesNotMatch(telegramBriefSignalLines(signal,'US_STOCK_ROOM').join('\n'),/새 신호 없음/u);
});

test('signal read is loopback-only, bounded, and fails closed on stale or foreign envelopes',async()=>{
  let calls=0;
  const fetchImpl=(async()=>{calls++;throw new Error('down');}) as unknown as typeof fetch;
  assert.deepEqual(await collectTelegramBriefSignalStatus(new Date(),fetchImpl,'https://example.org/v1/signals'),{status:'UNAVAILABLE'});
  assert.equal(calls,0);
  assert.deepEqual(await collectTelegramBriefSignalStatus(new Date(),fetchImpl),{status:'UNAVAILABLE'});
  assert.equal(calls,1);
  const stale=(async()=>new Response(JSON.stringify({ok:true,executionAuthority:'NONE',serviceSha:'a'.repeat(40),
    snapshot:{serviceSha:'a'.repeat(40),generatedAt:'2020-01-01T00:00:00Z'}}))) as unknown as typeof fetch;
  assert.deepEqual(await collectTelegramBriefSignalStatus(new Date(),stale),{status:'INVALID'});
});

test('brief carries the signal status section only when the engine was read',()=>{
  const base={kind:'MORNING' as const,localDate:'2026-10-18',destination:'KR_STOCK_ROOM' as const,
    destinationChatId:'kr',dedupeKey:'sig',now:new Date('2026-10-17T22:50:00Z')};
  assert.doesNotMatch(buildTelegramMarketBriefInput({...base,snapshot}).details||'',/신호 현황/u);
  const withSignal=buildTelegramMarketBriefInput({...base,snapshot:{...snapshot,signal:ready()}}).details||'';
  assert.match(withSignal,/\[신호 현황\]\n📭 국내주식 · 현재 새 신호 없음/u);
});
