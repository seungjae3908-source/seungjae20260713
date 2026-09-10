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
  if (destination === 'STOCK_ROOM') return '주식방 · 국내주식 / 미국주식';
  if (destination === 'CRYPTO_ROOM') return '코인방 · 코인현물 / 코인선물';
  return '개인 브리핑 · 전체 공개시장';
}

function destinationRooms(destination: TelegramReportDestination): ReadonlySet<MarketInformationRoomId> {
  if (destination === 'STOCK_ROOM') return new Set(STOCK_ROOMS);
  if (destination === 'CRYPTO_ROOM') return new Set(CRYPTO_ROOMS);
  return new Set(ROOMS);
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

function roomLines(room: BriefRoom): string[] {
  if (!room.response) return [`[${roomLabel(room.room)}] 데이터 공급 장애 · ${room.error ?? '원인 미확인'}`];
  const response = room.response;
  const lines = [`[${roomLabel(room.room)}] ${response.partial ? 'PARTIAL' : 'READY'}`];
  if (response.sections.indices.data.length) {
    const indices = response.sections.indices.data.slice(0, 4)
      .map((item) => `${item.label} ${number(item.value)} (${percent(item.changePercent)})`)
      .join(' · ');
    lines.push(`지수: ${indices}`);
  }
  const leaders = response.sections.rankings.data.slice(0, 3)
    .map((item) => `${item.name || item.symbol} ${percent(item.changePercent)}`)
    .join(' · ');
  if (leaders) lines.push(`거래대금/주요: ${leaders}`);
  if (room.room === 'coins-futures' && response.sections.derivatives.data) {
    const derivatives = response.sections.derivatives.data;
    if (derivatives.longRatio != null || derivatives.shortRatio != null) {
      lines.push(`선물 수급: LONG ${number(derivatives.longRatio)} · SHORT ${number(derivatives.shortRatio)} · L/S ${number(derivatives.longShortRatio)}`);
    }
  }
  const problemSections = Object.entries(response.sections)
    .filter(([, section]) => ['error', 'unavailable', 'stale'].includes(section.status))
    .map(([name, section]) => `${name}:${section.status}`);
  if (problemSections.length) lines.push(`데이터 상태: ${problemSections.join(' · ')}`);
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
    .flatMap((room) => room.response?.sections.news.data ?? [])
    .filter((item) => {
      const url = normalizeTelegramHttpUrl(item.url);
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    })
    .sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, 6);
}

function scopedWarnings(snapshot: TelegramMarketBriefSnapshot, destination: TelegramReportDestination): string[] {
  if (destination === 'PERSONAL') return snapshot.warnings;
  const allowed = destinationRooms(destination);
  return snapshot.warnings.filter((warning) => {
    const room = ROOMS.find((candidate) => warning.startsWith(`${candidate}:`));
    if (room) return allowed.has(room);
    if (destination === 'STOCK_ROOM') return warning === 'KR_THEME_UNAVAILABLE' || warning === 'US_THEME_UNAVAILABLE';
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
    `${reportLabel(input.kind)} · ${input.localDate}`,
    destinationLabel(input.destination),
    ...rooms.flatMap(roomLines),
  ];

  if (input.destination !== 'CRYPTO_ROOM') {
    lines.push(
      '',
      '[오늘의 테마/주도주]',
      ...themeLines('KR', input.snapshot.krThemes),
      ...themeLines('US', input.snapshot.usThemes),
    );
  }

  if (news.length) {
    lines.push('', `[뉴스 브리핑 · ${input.destination === 'CRYPTO_ROOM' ? '코인' : '주식'}]`);
    news.forEach((item, index) => lines.push(`${index + 1}. ${item.provider} · ${item.symbol} · ${item.title}`));
  } else {
    lines.push('', `[뉴스 브리핑 · ${input.destination === 'CRYPTO_ROOM' ? '코인' : '주식'}] 검증된 최신 뉴스 N/A`);
  }
  if (warnings.length) lines.push('', `데이터 경고: ${warnings.slice(0, 6).join(' · ')}`);
  lines.push('', '실제 데이터가 없는 값은 N/A로 유지하며 신호·수익률·목표가를 새로 만들지 않습니다.');

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
