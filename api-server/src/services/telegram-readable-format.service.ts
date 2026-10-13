/** Presentation-only whitespace policy shared by public and private Telegram sends. */
const SECTION_HEADING = /^\[[^\]\n]{1,72}\]/u;
const LONG_GROUP = /^(?:지수|거래대금\/주요|목표가|익절 계획|선물 수급):/u;
export function normalizeTelegramReadableText(value: unknown): string {
  const raw = String(value ?? '')
    .replace(/\r\n?/gu, '\n')
    .replace(/\\r\\n|\\n/gu, '\n')
    .replace(/[\u200B\uFEFF]/gu, '');
  const lines = raw.split('\n').map((line) => line.trim().replace(/[ \t]{2,}/gu, ' '));
  const result: string[] = [];
  for (const line of lines) {
    if (!line) {
      if (result.length && result.at(-1) !== '') result.push('');
      continue;
    }
    if (SECTION_HEADING.test(line) && result.length && result.at(-1) !== '') result.push('');
    if (LONG_GROUP.test(line) && line.length > 72 && line.includes(' · ')) {
      const [first, ...rest] = line.split(' · ');
      result.push(first);
      for (const item of rest) result.push('• ' + item);
      continue;
    }
    result.push(line);
  }
  return result.join('\n').replace(/\n{3,}/gu, '\n\n').trim();
}
