import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

test('remaining Korean-first presentation preserves internal Telegram and journal contracts', async () => {
  const [labels, telegram, journal, research, contract] = await Promise.all([
    readFile(path('../src/lib/labels.ts'), 'utf8'),
    readFile(path('../src/components/user-broker-telegram-panel.tsx'), 'utf8'),
    readFile(path('../src/components/unified-trade-journal-panel.tsx'), 'utf8'),
    readFile(path('../src/components/research-center-general.tsx'), 'utf8'),
    readFile(path('../src/lib/paper-journal-sync.ts'), 'utf8'),
  ]);
  const presentation = `${labels}\n${telegram}\n${journal}\n${research}`;

  for (const label of [
    '텔레그램',
    '매수', '롱', '숏', '거래 안 함', '대표 전략', '코인현물', '코인선물',
    '모의매매', '실시간 추적검증', '손익비 지수', '진입 전 판단 근거',
    '준비됨', '진행 중', '차단됨', '미수집', '확인 불가', '오래된 정보', '실패', '정상', '표본 부족',
  ]) expect(presentation).toContain(label);

  for (const legacy of [
    '개인 계좌 제공사 · 텔레그램 연결', '개인 Broker · Telegram 연결', 'Risk Engine', 'OrderPlan', 'Rich 차트',
    '<option value="APP_PAPER">Paper</option>', '<option value="APP_SHADOW">Shadow</option>',
    'label="Profit Factor"', 'label="Shadow 기록"',
  ]) expect(`${telegram}\n${journal}\n${research}`).not.toContain(legacy);

  for (const code of [
    "'APP_PAPER'", "'APP_SHADOW'", "'CRYPTO_SPOT'", "'CRYPTO_FUTURES'",
    "'PRE_TRADE_SNAPSHOT'", "'LONG'", "'SHORT'", "'OPEN'", "'CLOSED'",
  ]) expect(contract).toContain(code);

  for (const code of ["| 'BUY'", "| 'LONG'", "| 'SHORT'", "| 'NO_TRADE'", "| 'CHAMPION'", "| 'RESEARCH'"])
    expect(telegram).toContain(code);
});
