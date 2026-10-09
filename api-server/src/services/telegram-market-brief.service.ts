import { MarketInformationService } from './market-information.service';
import type {
  MarketInformationResponse,
  MarketInformationRoomId,
} from './market-information.contract';
import { SectorPopularService, type SectorPopularResult } from './sector-popular.service';
import type { TelegramIntelligenceReportKind, TelegramReportDestination } from './telegram-intelligence-report.service';
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
};

function reportLabel(kind: TelegramIntelligenceReportKind): string {
  switch (kind) {
    case 'MORNING': return '🌅 오늘의 시황';
    case 'KR_CLOSING': return '🇰🇷 국내장 마감 브리핑';
    case 'US_PREMARKET': return '🇺🇸 미국장 프리마켓 브리핑';
    case 'WEEKLY': return '📅 주간 시장 브리핑';
  }
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
  if (error instanceof Error) return `${error.name}:${error.message}`.replace(/https?:\/\/\S+/giu, '<provider>').slice(0, 160);
  return 'UNKNOWN_PROVIDER_ERROR';
}

export async function collectTelegramMarketBrief(): Promise<TelegramMarketBriefSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS);
  try {
    const roomPromises = ROOMS.map(async (room): Promise<BriefRoom> => {
      try {
        return { room, response: await MarketInformationService.getRoom(room, controller.signal), error: null };
      } catch (error) {
        return { room, response: null, error: safeError(error) };
      }
    });
    const [rooms, krThemeResult, usThemeResult] = await Promise.all([
      Promise.all(roomPromises),
      SectorPopularService.getSectorPopular('KR').catch(() => null),
      SectorPopularService.getSectorPopular('US').catch(() => null),
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
  const leaders = response.sections.rankings.data.slice(0, 5);
  if (leaders.length) {
    lines.push('', '[시장 주목 종목 TOP 5 · 관찰용]');
    leaders.forEach((item, index) => lines.push(
      String(index + 1) + '. ' + (item.name || item.symbol) + ' (' + item.symbol + ') ' +
      percent(item.changePercent) + ' · 매수 신호 아님',
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
  const delayed = Object.values(response.sections)
    .filter((section) => ['error', 'unavailable', 'stale'].includes(section.status)).length;
  if (delayed) lines.push('', '⚠️ ' + delayed + '개 데이터 항목 확인 지연');
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
  const lines = [
    reportLabel(input.kind) + ' · ' + input.localDate,
    destinationLabel(input.destination),
    '',
    ...rooms.flatMap(roomLines),
  ];
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
  lines.push('', '※ 근거 없는 수익률·신호·목표가는 만들지 않습니다.');

  const buttons: TelegramUrlButton[][] = [];
  for (const [index, item] of news.slice(0, 3).entries()) {
    const url = normalizeTelegramHttpUrl(item.url);
    if (url) buttons.push([{ text: `📰 주요뉴스 ${index + 1}`, url }]);
  }

  return {
    type: 'intelligence_report',
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
