import { MarketInformationService } from './market-information.service';
import type {
  MarketInformationResponse,
  MarketInformationRoomId,
} from './market-information.contract';
import { SectorPopularService, type SectorPopularResult } from './sector-popular.service';
import type { TelegramIntelligenceReportKind, TelegramReportDestination } from './telegram-intelligence-report.service';
import {
  collectTelegramBriefSignalStatus,
  telegramBriefSignalLines,
  type TelegramBriefSignalStatus,
} from './telegram-brief-signal-status.service';
import {
  normalizeTelegramHttpUrl,
  type TelegramAlertInput,
  type TelegramUrlButton,
} from './telegram-notification.service';

const BRIEF_TIMEOUT_MS = 8_000;
const STOCK_ROOMS: readonly MarketInformationRoomId[] = ['stocks-kr', 'stocks-us'];
const CRYPTO_ROOMS: readonly MarketInformationRoomId[] = ['coins-spot', 'coins-futures'];
const ROOMS: readonly MarketInformationRoomId[] = [...STOCK_ROOMS, ...CRYPTO_ROOMS];

type BriefRoom = {
  room: MarketInformationRoomId;
  response: MarketInformationResponse | null;
  error: string | null;
};

export type TelegramMarketBriefSnapshot = {
  generatedAt: string;
  rooms: BriefRoom[];
  krThemes: SectorPopularResult | null;
  usThemes: SectorPopularResult | null;
  warnings: string[];
  /** Signal V3 engine status; absent when the brief was built without it. */
  signal?: TelegramBriefSignalStatus | null;
};

function reportLabel(kind: TelegramIntelligenceReportKind): string {
  switch (kind) {
    case 'MORNING': return '아침 시황';
    case 'KR_CLOSING': return '국내장 마감 브리핑';
    case 'US_PREMARKET': return '미국장 개장 전 브리핑';
    case 'WEEKLY': return '주간 시장 브리핑';
  }
}

// Fixed-value coins are not market movers; listing them as a "TOP 5" row is noise.
const STABLECOINS = new Set(['USDT', 'USDC', 'DAI', 'TUSD', 'FDUSD', 'USDE', 'USDS', 'PYUSD', 'BUSD', 'USD1']);

function stablecoin(symbol: string): boolean {
  return STABLECOINS.has(symbol.toUpperCase().replace(/^KRW-/u, '').replace(/[-/]?KRW$/u, ''));
}

const SECTION_LABELS: Record<string, string> = {
  indices: '지수', rankings: '종목 순위', sectors: '업종', news: '뉴스', disclosures: '공시', derivatives: '선물 수급',
};

const KST_CLOCK = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

function kstParts(now: Date): { day: string; time: string } {
  const parts = Object.fromEntries(KST_CLOCK.formatToParts(now).map((part) => [part.type, part.value]));
  return { day: `${parts.month} ${parts.day}일 (${parts.weekday})`, time: `${parts.hour}:${parts.minute}` };
}

export function telegramMarketBriefTitle(kind: TelegramIntelligenceReportKind, destination: TelegramReportDestination, now: Date): string {
  return `${destinationLabel(destination)} ${reportLabel(kind)} · ${kstParts(now).day}`;
}

function roomLabel(room: MarketInformationRoomId): string {
  switch (room) {
    case 'stocks-kr': return '국내주식';
    case 'stocks-us': return '미국주식';
    case 'coins-spot': return '코인현물';
    case 'coins-futures': return '코인선물';
  }
}

function destinationLabel(destination: TelegramReportDestination): string {
  switch (destination) {
    case 'KR_STOCK_ROOM': return '🇰🇷 국내주식';
    case 'US_STOCK_ROOM': return '🇺🇸 해외주식';
    case 'CRYPTO_SPOT_ROOM': return '🪙 코인현물';
    case 'CRYPTO_FUTURES_ROOM': return '⚡ 코인선물';
  }
}

function destinationRooms(destination: TelegramReportDestination): ReadonlySet<MarketInformationRoomId> {
  switch (destination) {
    case 'KR_STOCK_ROOM': return new Set(['stocks-kr']);
    case 'US_STOCK_ROOM': return new Set(['stocks-us']);
    case 'CRYPTO_SPOT_ROOM': return new Set(['coins-spot']);
    case 'CRYPTO_FUTURES_ROOM': return new Set(['coins-futures']);
  }
}

function stockDestination(destination: TelegramReportDestination): boolean {
  return destination === 'KR_STOCK_ROOM' || destination === 'US_STOCK_ROOM';
}

function number(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
}

function percent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function safeError(error: unknown): string {
  // Never forward raw provider exception text into a Telegram digest.
  // Exceptions can contain URL query strings, account refs, or secrets.
  return error instanceof Error && error.name === 'AbortError'
    ? 'PUBLIC_PROVIDER_TIMEOUT' : 'PUBLIC_PROVIDER_UNAVAILABLE';
}

/** Hard bound for OPTIONAL public market/theme sources.
 * Abort is passed to market-room fetches where supported; sources without
 * AbortSignal (sector rankings) cannot hold up the scheduled report.
 * Late results are discarded, never promoted as current Telegram evidence.
 */
export async function boundedTelegramBriefRead<T>(
  read: () => Promise<T>,
  timeoutMs = BRIEF_TIMEOUT_MS,
): Promise<T | null> {
  if (typeof read !== 'function' || !Number.isSafeInteger(timeoutMs)
    || timeoutMs < 1 || timeoutMs > BRIEF_TIMEOUT_MS)
    return null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T | null>([
      Promise.resolve().then(read).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function collectTelegramMarketBrief(): Promise<TelegramMarketBriefSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS);
  try {
    const roomPromises = ROOMS.map(async (room): Promise<BriefRoom> => {
      try {
        const response = await boundedTelegramBriefRead(
          () => MarketInformationService.getRoom(room, controller.signal));
        return { room, response, error: response ? null : 'PUBLIC_PROVIDER_TIMEOUT_OR_UNAVAILABLE' };
      } catch (error) {
        return { room, response: null, error: safeError(error) };
      }
    });
    const [rooms, krThemeResult, usThemeResult, signal] = await Promise.all([
      Promise.all(roomPromises),
      boundedTelegramBriefRead(() => SectorPopularService.getSectorPopular('KR')),
      boundedTelegramBriefRead(() => SectorPopularService.getSectorPopular('US')),
      boundedTelegramBriefRead(() => collectTelegramBriefSignalStatus()),
    ]);
    const warnings = rooms.flatMap((item) => item.error ? [`${item.room}:${item.error}`] : []);
    if (!krThemeResult) warnings.push('KR_THEME_UNAVAILABLE');
    if (!usThemeResult) warnings.push('US_THEME_UNAVAILABLE');
    return {
      generatedAt: new Date().toISOString(),
      rooms,
      krThemes: krThemeResult,
      usThemes: usThemeResult,
      warnings,
      signal,
    };
  } finally {
    clearTimeout(timeout);
  }
}

function marketTone(response: MarketInformationResponse): string {
  if (response.partial || response.sections.indices.status !== 'ready') return '자료 확인 중';
  const moves = response.sections.indices.data.map((row) => row.changePercent)
    .filter((value): value is number => value != null && Number.isFinite(value));
  if (moves.length < 2) return '판정 보류 (지수 근거 부족)';
  const positive = moves.filter((n) => n > 0).length;
  const negative = moves.filter((n) => n < 0).length;
  if (positive >= Math.ceil(moves.length * 0.7)) return '상승 우위';
  if (negative >= Math.ceil(moves.length * 0.7)) return '하락 우위';
  return '혼조';
}

function roomLines(room: BriefRoom): string[] {
  if (!room.response) return [
    '[' + roomLabel(room.room) + '] 데이터 공급 지연',
    '지수·종목·수급: N/A (검증된 자료 없음)',
  ];
  const response = room.response;
  const lines = [
    '[' + roomLabel(room.room) + '] ' + (response.partial ? '일부 데이터 확인 중' : '데이터 정상'),
    '시장 분위기: ' + marketTone(response) + ' (지수 등락 기준 · 매매 신호 아님)',
  ];
  if (response.sections.indices.data.length) {
    lines.push('', '[주요 지수]');
    response.sections.indices.data.slice(0, 4).forEach((item) => {
      lines.push('• ' + item.label + ': ' + number(item.value) + ' (' + percent(item.changePercent) + ')');
    });
  }
  const leaders = response.sections.rankings.data
    .filter((item) => room.room !== 'coins-spot' || !stablecoin(item.symbol))
    .slice(0, 5);
  if (leaders.length) {
    lines.push('', '[시장 주목 종목 TOP 5 · 관찰용]');
    leaders.forEach((item, index) => lines.push(
      String(index + 1) + '. ' +
      (item.name && item.name !== item.symbol ? item.name + ' (' + item.symbol + ')' : item.symbol) + ' ' +
      percent(item.changePercent),
    ));
  } else lines.push('', '[시장 주목 종목] N/A (확인된 순위 없음)');

  if (room.room === 'coins-futures' && response.sections.derivatives.data) {
    const derivatives = response.sections.derivatives.data;
    if (derivatives.longRatio != null || derivatives.shortRatio != null) {
      lines.push('', '[선물 수급]');
      lines.push('LONG: ' + number(derivatives.longRatio));
      lines.push('SHORT: ' + number(derivatives.shortRatio));
      lines.push('LONG/SHORT 비율: ' + number(derivatives.longShortRatio));
    }
  }
  const delayed = Object.entries(response.sections)
    .filter(([, section]) => ['error', 'unavailable', 'stale'].includes(section.status))
    .map(([key]) => SECTION_LABELS[key] ?? key);
  if (delayed.length) lines.push('', '⚠️ 확인 지연: ' + delayed.join(', '));
  return lines;
}

function themeLines(label: string, data: SectorPopularResult | null): string[] {
  if (!data) return [`${label} 테마: N/A`];
  const ranked = data.sectors
    .map((sector) => ({
      sector,
      tradingValue: sector.rows.reduce((sum, row) => sum + (Number.isFinite(row.tradingValue) ? row.tradingValue : 0), 0),
    }))
    .filter((item) => item.sector.rows.length > 0)
    .sort((left, right) => right.tradingValue - left.tradingValue)
    .slice(0, 3);
  if (!ranked.length) return [`${label} 테마: N/A`];
  return ranked.map(({ sector }) => {
    const stocks = sector.rows.slice(0, 3).map((row) => `${row.name}(${percent(row.changePercent)})`).join(', ');
    return `${label} 테마 · ${sector.label}: ${stocks}`;
  });
}

function newsRows(rooms: readonly BriefRoom[]) {
  const seen = new Set<string>();
  return rooms
    .flatMap((room) => [
      ...(room.response?.sections.news.data ?? []),
      ...(room.response?.sections.disclosures.data ?? []),
    ])
    .filter((item) => {
      const url = normalizeTelegramHttpUrl(item.url);
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, 6);
}

function warningLabel(warning: string): string {
  if (warning.startsWith('stocks-kr:')) return '국내주식 데이터 일부 확인 지연';
  if (warning.startsWith('stocks-us:')) return '해외주식 데이터 일부 확인 지연';
  if (warning.startsWith('coins-spot:')) return '코인현물 데이터 일부 확인 지연';
  if (warning.startsWith('coins-futures:')) return '코인선물 데이터 일부 확인 지연';
  if (warning === 'KR_THEME_UNAVAILABLE') return '국내 테마 정보 확인 지연';
  if (warning === 'US_THEME_UNAVAILABLE') return '해외 테마 정보 확인 지연';
  return '일부 시장데이터 확인 필요';
}

function scopedWarnings(snapshot: TelegramMarketBriefSnapshot, destination: TelegramReportDestination): string[] {
  const allowed = destinationRooms(destination);
  return snapshot.warnings.filter((warning) => {
    const room = ROOMS.find((candidate) => warning.startsWith(`${candidate}:`));
    if (room) return allowed.has(room);
    if (destination === 'KR_STOCK_ROOM') return warning === 'KR_THEME_UNAVAILABLE';
    if (destination === 'US_STOCK_ROOM') return warning === 'US_THEME_UNAVAILABLE';
    return false;
  });
}

export function buildTelegramMarketBriefInput(input: {
  kind: TelegramIntelligenceReportKind;
  localDate: string;
  destination: TelegramReportDestination;
  destinationChatId: string;
  dedupeKey: string;
  now: Date;
  snapshot: TelegramMarketBriefSnapshot;
}): TelegramAlertInput {
  const allowed = destinationRooms(input.destination);
  const rooms = input.snapshot.rooms.filter((room) => allowed.has(room.room));
  const news = newsRows(rooms);
  const warnings = scopedWarnings(input.snapshot, input.destination);
  const lines = [...rooms.flatMap(roomLines)];
  if (input.destination === 'KR_STOCK_ROOM') {
    lines.push('', '[오늘의 테마/주도주]', ...themeLines('KR', input.snapshot.krThemes));
  } else if (input.destination === 'US_STOCK_ROOM') {
    lines.push('', '[오늘의 테마/주도주]', ...themeLines('US', input.snapshot.usThemes));
  }
  if (input.kind === 'WEEKLY') {
    lines.push('', '[주간 성과]', '1주 누적 수익률: N/A (검증된 기간별 시계열 미연결)');
  }
  if (stockDestination(input.destination) && (input.kind === 'MORNING' || input.kind === 'US_PREMARKET')) {
    lines.push('', '[주요 경제 일정]', '검증된 발표 일정: N/A (경제 일정 데이터 미연결)');
  }
  if (input.snapshot.signal !== undefined) {
    lines.push(...telegramBriefSignalLines(input.snapshot.signal, input.destination));
  }
  const newsScope = stockDestination(input.destination) ? '주식' : '코인';
  lines.push('', '[주요 뉴스·공시 · ' + newsScope + ']');
  if (news.length) {
    for (const [index, item] of news.slice(0, 5).entries()) {
      const kind = item.kind === 'disclosure' ? '공시' : '뉴스';
      lines.push(String(index + 1) + '. [' + kind + '] ' + item.provider + ' · ' + item.symbol);
      lines.push(item.title);
      const summary = typeof item.summary === 'string' ? item.summary.trim() : '';
      if (summary) lines.push('기사 요약: ' + summary.slice(0, 180));
    }
  } else lines.push('검증된 최신 뉴스 N/A · 확인된 공시 N/A');
  if (warnings.length) lines.push('', '⚠️ ' + [...new Set(warnings.slice(0, 6).map(warningLabel))].join(' · '));
  const clock = kstParts(input.now);
  lines.push('', '※ 관찰용 정보이며 매수·매도 신호가 아닙니다.', '기준 시각 ' + clock.day + ' ' + clock.time + ' (한국 시간)');

  const buttons: TelegramUrlButton[][] = [];
  for (const [index, item] of news.slice(0, 3).entries()) {
    const url = normalizeTelegramHttpUrl(item.url);
    if (url) buttons.push([{ text: `📰 주요뉴스 ${index + 1}`, url }]);
  }

  return {
    type: 'intelligence_report',
    // A custom title replaces the generic header and the raw UTC timestamp line.
    title: telegramMarketBriefTitle(input.kind, input.destination, input.now),
    market: input.destination,
    details: lines.join('\n').slice(0, 3_500),
    timestamp: input.now.toISOString(),
    destinationChatId: input.destinationChatId,
    dedupeKey: input.dedupeKey,
    duplicateWindowMs: 24 * 60 * 60 * 1000,
    cooldownMs: 0,
    linkPreview: news.length > 0,
    buttons,
  };
}
