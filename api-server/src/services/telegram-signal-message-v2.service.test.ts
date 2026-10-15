import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTelegramReadableText } from './telegram-readable-format.service';
import {
  entryTranchesV2,
  renderNoSignalLineV2,
  renderSignalMessageV2,
  signalMessageInputFromV3Row,
  type SignalMessageInput,
} from './telegram-signal-message-v2.service';

const NOW = Date.parse('2026-10-15T01:10:00.000Z');

function kr(overrides: Partial<SignalMessageInput> = {}): SignalMessageInput {
  return {
    market: 'KR_STOCK', symbol: '005930', name: '삼성전자', direction: 'BUY', strategy: 'MID_LONG', timeframe: '1D',
    validationTier: 'RESEARCH_CANDIDATE', price: 220_000, entryZone: { from: 218_000, to: 222_000 }, stopLoss: 210_000,
    targets: [232_000, 240_000, 250_000], utilityR: 0.42,
    evidence: [{ text: '20봉 평균 > 50봉 평균', source: '연구센터 조합' }, { text: '거래량 2배', source: '검색기' }],
    research: { validationTrades: 60, validationMeanReturn: 0.00686, validationWinRate: 0.67, holdoutTrades: 15, holdoutMeanReturn: 0.004, holdoutPeriod: '2026-01-01~2026-08-09' },
    observedAt: '2026-10-15T01:05:00.000Z', expiresAt: '2026-10-16T01:05:00.000Z', ...overrides,
  };
}

test('owner layout: title, key numbers, then 근거/계획/검증 blocks separated by blank lines with sources', () => {
  const message = renderSignalMessageV2(kr(), { appBaseUrl: 'https://lsj119.com', nowMs: NOW });
  assert.ok(message);
  assert.equal(message!.title, '🟢 [국내주식] 삼성전자 (005930) · 매수 신호');
  const text = normalizeTelegramReadableText(message!.details);
  const blocks = text.split('\n\n');
  assert.match(blocks[0], /^중장기 · 일봉$/u);
  assert.match(blocks[1], /💰 현재가 220,000\n진입 218,000 ~ 222,000\n목표 1차 232,000 \(\+5\.5%\)/u);
  assert.match(blocks[1], /손절 210,000 \(-4\.5%\)/u);
  assert.match(blocks[2], /^📌 근거\n· 20봉 평균 > 50봉 평균 \(연구센터 조합\)\n· 거래량 2배 \(검색기\)$/u);
  assert.match(blocks[3], /^🎯 계획\n· 매수 1·2·3차 30\/30\/40%: 222,000 → 220,000 → 218,000/u);
  assert.match(blocks[3], /매도 1·2·3차 30\/30\/40%: 232,000 → 240,000 → 250,000/u);
  assert.match(blocks[3], /손절 210,000 닿으면 전량 정리/u);
  assert.match(blocks[4], /^📊 검증\n· 단계: 연구 검증/u);
  assert.match(blocks[4], /과거 검증 60회 · 거래당 \+0\.69% · 승률 67%/u);
  assert.match(blocks[5], /^🕒 10월 15일 10:05 기준/u);
  for (const code of ['KR_STOCK', 'RESEARCH_CANDIDATE', 'MID_LONG', 'undefined', 'NaN', 'null']) assert.equal(text.includes(code), false, code);
  assert.deepEqual(message!.buttons[0].map((b) => b.text), ['🛒 구매', '📊 차트']);
  assert.match(message!.buttons[0][0].url, /^https:\/\/lsj119\.com\/telegram-order\?market=KR&symbol=005930/u);
  assert.match(message!.buttons[0][1].url, /^https:\/\/lsj119\.com\/ai-chart\?assetType=stock&market=KR&symbol=005930/u);
});

test('nothing is sent for non-signals, incomplete plans, unsourced evidence or expired signals', () => {
  const opts = { nowMs: NOW };
  assert.equal(renderSignalMessageV2(kr({ direction: 'SHORT' }), opts), null); // stocks: buy only
  assert.equal(renderSignalMessageV2(kr({ targets: [] }), opts), null);
  assert.equal(renderSignalMessageV2(kr({ targets: [215_000] }), opts), null); // target not in favour
  assert.equal(renderSignalMessageV2(kr({ stopLoss: 219_000 }), opts), null); // 3rd tranche below stop
  assert.equal(renderSignalMessageV2(kr({ evidence: [{ text: '거래량 미확인', source: '검색기' }] }), opts), null);
  assert.equal(renderSignalMessageV2(kr({ evidence: [{ text: '거래량 2배', source: '' }] }), opts), null);
  assert.equal(renderSignalMessageV2(kr({ expiresAt: '2026-10-15T01:00:00.000Z' }), opts), null);
});

test('futures short fills from the bottom of the zone up and shows leverage', () => {
  const message = renderSignalMessageV2({
    ...kr(), market: 'CRYPTO_FUTURES', symbol: 'BTCUSDT', name: null, direction: 'SHORT', strategy: 'SWING', timeframe: '60m',
    price: 100_000, entryZone: { from: 99_500, to: 100_500 }, stopLoss: 102_000, targets: [97_000, 95_000],
    leverage: { min: 2, max: 3, hardMaximum: 5 },
  }, { appBaseUrl: 'https://lsj119.com', nowMs: NOW });
  assert.ok(message);
  assert.equal(message!.title, '🔴 [코인선물] BTCUSDT · 숏(SHORT) 신호');
  assert.match(message!.details, /숏 진입 1·2·3차 30\/30\/40%: 99,500 → 100,000 → 100,500/u);
  assert.match(message!.details, /숏 정리 1·2·3차 30\/30%: 97,000 → 95,000/u);
  assert.match(message!.details, /레버리지 참고 2~3배 \(최대 5배\)/u);
  assert.equal(message!.buttons[0][0].text, '🛒 숏 주문');
  assert.deepEqual(entryTranchesV2({ entryZone: { from: 10, to: 12 }, stopLoss: 9, direction: 'BUY' }), [12, 11, 10]);
});

test('one-line no-signal message', () => {
  assert.equal(renderNoSignalLineV2('US_STOCK', '오늘', 4210), '📭 해외주식 · 오늘 새 신호 없음 (4,210종목 확인)');
  assert.equal(renderNoSignalLineV2('CRYPTO_SPOT', '오전'), '📭 코인현물 · 오전 새 신호 없음');
});

test('maps a Signal V3 row with research evidence and the cycle signal plan', () => {
  const input = signalMessageInputFromV3Row({
    market: 'KR_STOCK', symbol: '005930', direction: 'BUY', strategy: 'COMBINATION_RESEARCH', timeframe: '1D',
    validationTier: 'RESEARCH_CANDIDATE', utilityR: 0.4, sourceAsOf: '2026-10-15T01:05:00.000Z', leverage: null,
    provenance: {
      sourceExpiresAt: '2026-10-16T01:05:00.000Z',
      signalPlan: { name: '삼성전자', price: 220000, entryZone: { from: 218000, to: 222000 }, stopLoss: 210000, targets: [232000], reasons: ['거래량 2배'] },
      researchEvidence: { source: 'RESEARCH_COMBINATION_HOLDOUT_PASSED', labels: ['20봉 평균 > 50봉 평균'],
        validation: { trades: 60, meanReturn: 0.0069, winRate: 0.67 }, holdout: { trades: 15, meanReturn: 0.004, period: { start: '2026-01-01', end: '2026-08-09' } } },
    },
  });
  assert.ok(input);
  assert.deepEqual(input!.evidence.map((e) => e.source), ['연구센터 조합', '검색기']);
  const message = renderSignalMessageV2(input!, { nowMs: NOW });
  assert.ok(message);
  assert.match(message!.details, /^연구 조합 · 일봉/u);
  assert.match(message!.details, /2026 봉인 데이터 확인 15회/u);
  assert.equal(signalMessageInputFromV3Row({ provenance: {} }), null);
});
