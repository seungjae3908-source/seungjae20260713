import assert from 'node:assert/strict';
import test from 'node:test';
import { buildTelegramMarketBriefInput, type TelegramMarketBriefSnapshot } from './telegram-market-brief.service';

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
