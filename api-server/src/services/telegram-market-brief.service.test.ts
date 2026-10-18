import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildTelegramMarketBriefInput, boundedTelegramBriefRead,
  type TelegramMarketBriefSnapshot,
} from './telegram-market-brief.service';
import { dueTelegramIntelligenceReports } from './telegram-intelligence-report.service';
import { renderTelegramAlert } from './telegram-notification.service';

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
