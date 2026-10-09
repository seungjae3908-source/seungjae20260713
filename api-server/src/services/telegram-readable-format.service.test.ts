import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTelegramReadableText } from './telegram-readable-format.service';

test('converts literal escaped newlines into Telegram paragraphs',()=>{
  const output=normalizeTelegramReadableText('진입: 100\\n목표가: 110\r\n\r\n[AI 분석]\n• 근거 1');
  assert.match(output,/^진입: 100\n목표가: 110\n\n\[AI 분석\]\n• 근거 1$/u);
  assert.equal(output.includes('\\n'),false);
});
test('splits long target plans into scan-friendly lines without losing numbers',()=>{
  const output=normalizeTelegramReadableText('목표가: TP1 100 (+5%) · TP2 110 (+10%) · TP3 120 (+20%) · TP4 130 (+30%) · TP5 140 (+40%)');
  assert.match(output,/^목표가: TP1 100/u);
  assert.match(output,/\n• TP2 110/u);
  assert.match(output,/\n• TP5 140/u);
});
test('sections get a single paragraph boundary with existing monetary values retained',()=>{
  const output=normalizeTelegramReadableText('현재가 12,345\n[자동매매 판단 근거]\n• 보유   유지\n\n\n[체결 비용/품질]\n수수료: 0.3');
  assert.match(output,/현재가 12,345\n\n\[자동매매 판단 근거\]\n• 보유 유지\n\n\[체결 비용\/품질\]\n수수료: 0.3/u);
  assert.doesNotMatch(output,/\n{3,}/u);
});
