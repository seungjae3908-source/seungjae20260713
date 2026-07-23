export const CURRENCY_MODE_KEY = 'stock-currency-mode';
export const ACCENT_COLOR_KEY = 'app-accent-color';
export const APPEARANCE_KEY = 'app-appearance-mode';

export type CurrencyMode = 'native' | 'krw' | 'usd';
export type AccentColor = 'blue' | 'green' | 'purple' | 'orange' | 'red';
export type AppearanceMode = 'light' | 'dark' | 'system';

export const ACCENT_COLORS: {
  key: AccentColor;
  label: string;
  className: string;
}[] = [
  {
    key: 'blue',
    label: '파랑',
    className: 'bg-blue-500',
  },
  {
    key: 'green',
    label: '초록',
    className: 'bg-green-500',
  },
  {
    key: 'purple',
    label: '보라',
    className: 'bg-purple-500',
  },
  {
    key: 'orange',
    label: '주황',
    className: 'bg-orange-500',
  },
  {
    key: 'red',
    label: '빨강',
    className: 'bg-red-500',
  },
];

const USD_KRW = 1300;

const KO_NAME_MAP: Record<string, string> = {
  AAPL: '애플',
  NVDA: '엔비디아',
  MSFT: '마이크로소프트',
  TSLA: '테슬라',
  AMZN: '아마존',
  GOOGL: '알파벳',
  GOOG: '알파벳',
  META: '메타 플랫폼스',
  AMD: 'AMD',
  PLTR: '팔란티어',
  RGTI: '리게티 컴퓨팅',
  SOFI: '소파이',
  AAL: '아메리칸 항공',
  INTC: '인텔',
  NFLX: '넷플릭스',
  AVGO: '브로드컴',
  COIN: '코인베이스',
  UBER: '우버',
  MU: '마이크론 테크놀로지',
  QCOM: '퀄컴',
  TSM: 'TSMC',
  ORCL: '오라클',
  CRM: '세일즈포스',
  ADBE: '어도비',
  DIS: '디즈니',
  KO: '코카콜라',
  PEP: '펩시코',
  MCD: '맥도날드',
  SBUX: '스타벅스',
  NKE: '나이키',
  V: '비자',
  MA: '마스터카드',
  JPM: 'JP모건',
  BAC: '뱅크오브아메리카',
  GS: '골드만삭스',
  BRK_B: '버크셔해서웨이',
  'BRK.B': '버크셔해서웨이',
  XOM: '엑슨모빌',
  CVX: '셰브런',
  JNJ: '존슨앤드존슨',
  PFE: '화이자',
  LLY: '일라이릴리',
  UNH: '유나이티드헬스',
  WMT: '월마트',
  COST: '코스트코',
  BA: '보잉',
  CAT: '캐터필러',
  GE: 'GE',
  F: '포드',
  GM: '제너럴모터스',
  RIVN: '리비안',
  LCID: '루시드',
  ARM: 'ARM홀딩스',
  SMCI: '슈퍼마이크로',
  DELL: '델',
  IBM: 'IBM',
  CSCO: '시스코',
  TXN: '텍사스인스트루먼트',
  MRVL: '마벨 테크놀로지',
  SNOW: '스노우플레이크',
  SHOP: '쇼피파이',
  PYPL: '페이팔',
  SQ: '블록',
  HOOD: '로빈후드',
  MSTR: '마이크로스트래티지',
  ABNB: '에어비앤비',
  LYFT: '리프트',
  SPOT: '스포티파이',
  RBLX: '로블록스',
  U: '유니티',
  '005930': '삼성전자',
  '000660': 'SK하이닉스',
  '005380': '현대차',
  '035420': '네이버',
  '035720': '카카오',
  '373220': 'LG에너지솔루션',
  '207940': '삼성바이오로직스',
  '068270': '셀트리온',
  '360750': 'TIGER 미국S&P500',
};

const TRANSLATION_RULES: Array<[RegExp, string]> = [
  [/atm offering/gi, 'ATM 희석'],
  [/nasdaq deficiency notice/gi, '나스닥 상장유지 요건 미달 통지'],
  [/nyse delisting notice/gi, '뉴욕증권거래소 상장폐지 경고'],
  [/delisting notice/gi, '상장폐지 경고'],
  [/listing compliance failure/gi, '상장유지 요건 미달'],
  [/sec filing/gi, 'SEC 공시'],
  [/form 8-k/gi, '8-K 공시'],
  [/form 10-k/gi, '연간보고서'],
  [/form 10-q/gi, '분기보고서'],
  [/form 6-k/gi, '6-K 공시'],
  [/reverse split/gi, '역분할'],
  [/stock split/gi, '주식분할'],
  [/announces?/gi, '발표'],
  [/reports?/gi, '발표'],
  [/earnings/gi, '실적'],
  [/revenue/gi, '매출'],
  [/net income/gi, '순이익'],
  [/operating income/gi, '영업이익'],
  [/offering/gi, '희석 자금조달'],
  [/contract/gi, '계약'],
  [/partnership/gi, '파트너십'],
  [/fda approval/gi, 'FDA 승인'],
  [/lawsuit/gi, '소송'],
  [/guidance/gi, '가이던스'],
  [/quarterly/gi, '분기'],
  [/annual/gi, '연간'],
  [/results/gi, '결과'],
  [/common stock/gi, '보통주'],
  [/shares/gi, '주식'],
  [/merger/gi, '합병'],
  [/acquisition/gi, '인수'],
];

function safeLocalStorageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalStorageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // storage unavailable
  }
}

export function getCurrencyMode(): CurrencyMode {
  const value = safeLocalStorageGet(CURRENCY_MODE_KEY);

  if (value === 'krw' || value === 'usd' || value === 'native') {
    return value;
  }

  return 'native';
}

export function setCurrencyMode(value: CurrencyMode): void {
  safeLocalStorageSet(CURRENCY_MODE_KEY, value);
}

export function getAccentColor(): AccentColor {
  const value = safeLocalStorageGet(ACCENT_COLOR_KEY);

  if (
    value === 'blue' ||
    value === 'green' ||
    value === 'purple' ||
    value === 'orange' ||
    value === 'red'
  ) {
    return value;
  }

  return 'blue';
}

export function setAccentColor(value: AccentColor): void {
  safeLocalStorageSet(ACCENT_COLOR_KEY, value);
  applyAccentColor(value);
}

export function applyAccentColor(value = getAccentColor()): void {
  try {
    const root = document.documentElement;

    root.dataset.accent = value;
  } catch {
    // document unavailable
  }
}

export function getAppearanceMode(): AppearanceMode {
  const value = safeLocalStorageGet(APPEARANCE_KEY);

  if (value === 'light' || value === 'dark' || value === 'system') {
    return value;
  }

  return 'system';
}

export function setAppearanceMode(value: AppearanceMode): void {
  safeLocalStorageSet(APPEARANCE_KEY, value);
  applyAppearanceMode(value);
}

export function applyAppearanceMode(value = getAppearanceMode()): void {
  try {
    const root = document.documentElement;
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const shouldDark = value === 'dark' || (value === 'system' && prefersDark);

    root.classList.toggle('dark', shouldDark);
  } catch {
    // document unavailable
  }
}

export function displayStockName(ticker: string, name: string, _market?: string) {
  const t = String(ticker ?? '').toUpperCase();

  if (KO_NAME_MAP[t]) return KO_NAME_MAP[t];

  return String(name || ticker)
    .replace(/Corporation/gi, '')
    .replace(/Corp\./gi, '')
    .replace(/Inc\./gi, '')
    .replace(/Inc/gi, '')
    .replace(/Ltd\./gi, '')
    .replace(/Limited/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// 주요 코인 한글명 (업비트가 한글명을 주지 않는 경우·비트겟 선물용 폴백)
const COIN_KO_MAP: Record<string, string> = {
  BTC: '비트코인',
  ETH: '이더리움',
  XRP: '리플',
  SOL: '솔라나',
  DOGE: '도지코인',
  ADA: '에이다',
  TRX: '트론',
  LINK: '체인링크',
  AVAX: '아발란체',
  DOT: '폴카닷',
  SUI: '수이',
  XLM: '스텔라루멘',
  BCH: '비트코인캐시',
  LTC: '라이트코인',
  ETC: '이더리움클래식',
  PEPE: '페페',
  SHIB: '시바이누',
  USDT: '테더',
  HBAR: '헤데라',
  NEAR: '니어프로토콜',
  APT: '앱토스',
  ARB: '아비트럼',
  OP: '옵티미즘',
  ATOM: '코스모스',
  UNI: '유니스왑',
  ONDO: '온도파이낸스',
  POL: '폴리곤',
  MATIC: '폴리곤',
  SEI: '세이',
  STX: '스택스',
  AAVE: '에이브',
  ENS: '이더리움네임서비스',
};

// 심볼에서 기초 코인만 추출: 'KRW-BTC' → 'BTC', 'BTCUSDT' → 'BTC'
function coinBaseSymbol(symbol: string): string {
  const raw = String(symbol ?? '').toUpperCase().trim();
  const dashed = raw.includes('-') ? raw.split('-').pop() ?? raw : raw;
  return dashed.replace(/(USDT|USDC|KRW|BTC)$/u, (m) => (dashed === m ? m : '')) || dashed;
}

export function displayCoinName(symbol: string, koreanName?: unknown, englishName?: unknown) {
  const ko = String(koreanName ?? '').trim();
  if (ko) return ko;
  const base = coinBaseSymbol(symbol);
  if (COIN_KO_MAP[base]) return COIN_KO_MAP[base];
  const en = String(englishName ?? '').trim();
  return en || String(symbol ?? '');
}

export function translateMarketText(value: unknown) {
  const raw = String(value ?? '').trim();

  if (!raw) return '';

  let text = raw;

  for (const [pattern, replacement] of TRANSLATION_RULES) {
    text = text.replace(pattern, replacement);
  }

  text = text
    .replace(/\bAAPL\b/g, '애플')
    .replace(/\bNVDA\b/g, '엔비디아')
    .replace(/\bMSFT\b/g, '마이크로소프트')
    .replace(/\bRGTI\b/g, '리게티 컴퓨팅')
    .replace(/\bTSLA\b/g, '테슬라')
    .replace(/\bAMZN\b/g, '아마존')
    .replace(/\bMETA\b/g, '메타')
    .replace(/\bPLTR\b/g, '팔란티어');

  return text;
}

export function summarizeText(
  value: unknown,
  fallback = '요약 데이터가 부족합니다.',
) {
  const text = translateMarketText(value);

  if (!text) return fallback;

  if (text.length <= 90) return text;

  return `${text.slice(0, 90).trim()}…`;
}

export function normalizePlanText(value: string, currency: string) {
  return String(value ?? '')
    .replace(/\$/g, currency === 'KRW' ? '' : '$')
    .replace(/원원/g, '원')
    .replace(/\s+/g, ' ')
    .trim();
}

export function formatAppPercent(value: unknown) {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.replace('%', '').replace(',', ''))
        : 0;

  if (!Number.isFinite(n)) return '0.00%';

  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

export function formatAppPrice(value: unknown, currency: string) {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value.replace(/,/g, '').replace(/[^\d.-]/g, ''))
        : null;

  if (n == null || !Number.isFinite(n)) return '확인중';

  const mode = getCurrencyMode();

  if (mode === 'krw' && currency === 'USD') {
    return `${Math.round(n * USD_KRW).toLocaleString()}원`;
  }

  if (mode === 'usd' && currency === 'KRW') {
    return `$${(n / USD_KRW).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    })}`;
  }

  if (currency === 'USD') {
    return `$${n.toLocaleString(undefined, {
      maximumFractionDigits: n >= 100 ? 2 : 4,
    })}`;
  }

  // USDT(비트겟 선물 등)는 원화가 아니므로 절대 '원'으로 표기하지 않는다.
  if (currency === 'USDT') {
    if (mode === 'krw') {
      return `${Math.round(n * USD_KRW).toLocaleString()}원`;
    }
    return `${n.toLocaleString(undefined, {
      maximumFractionDigits: n >= 100 ? 2 : 4,
    })} USDT`;
  }

  return `${Math.round(n).toLocaleString()}원`;
}

export function eventLabelKo(value: unknown) {
  const text = String(value ?? '').toLowerCase();

  if (/delisting|상장폐지|deficiency|compliance failure/.test(text)) {
    return '상장폐지 경고';
  }

  if (/offering|atm|유상증자|전환사채|cb|bw|신주발행/.test(text)) {
    return '희석 리스크';
  }

  if (/contract|supply|계약|수주/.test(text)) return '계약건';
  if (/approval|fda|승인/.test(text)) return '승인건';
  if (/earnings|revenue|매출|실적/.test(text)) return '실적';
  if (/lawsuit|소송/.test(text)) return '소송';

  return translateMarketText(value) || '공시/뉴스';
}

export function toneKo(value: unknown) {
  const text = String(value ?? '').toLowerCase();

  if (text.includes('positive')) return '긍정';
  if (text.includes('negative')) return '부정';

  return '중립';
}
// ---------------------------------------------------------------------------
// Watchlist storage (localStorage) — restored section.
// Consumed by lib/watchlist.ts, hooks/use-watchlist.ts and pages/watchlist.tsx.
// ---------------------------------------------------------------------------
export const WATCHLIST_KEY = 'seungjae_watchlist_v1';
export const WATCHLIST_CHANGE_EVENT = 'seungjae-watchlist-changed';

export interface WatchlistItem {
  ticker: string;
  name: string;
  market?: string;
  currency?: string;
  price?: number | null;
  changePercent?: number | null;
  aiScore?: number | null;
  classification?: string;
  reason?: string;
  /** 사용자가 지정한 목표가 (Supabase에 동기화됨). */
  targetPrice?: number | null;
}

export function readWatchlistItems(): WatchlistItem[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(WATCHLIST_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (typeof item === 'string') {
          return { ticker: item, name: item } satisfies WatchlistItem;
        }
        if (item && typeof item === 'object' && typeof item.ticker === 'string') {
          return item as WatchlistItem;
        }
        return null;
      })
      .filter((item): item is WatchlistItem => item !== null);
  } catch {
    return [];
  }
}

export function writeWatchlistItems(items: WatchlistItem[]): void {
  if (typeof window === 'undefined') return;
  const unique = new Map<string, WatchlistItem>();
  items.forEach((item) => {
    unique.set(item.ticker.toUpperCase(), {
      ...item,
      ticker: item.ticker.toUpperCase(),
    });
  });
  window.localStorage.setItem(
    WATCHLIST_KEY,
    JSON.stringify(Array.from(unique.values())),
  );
  window.dispatchEvent(new Event(WATCHLIST_CHANGE_EVENT));
}

export function setWatchlistTargetPrice(
  ticker: string,
  targetPrice: number | null,
): void {
  const upper = ticker.toUpperCase();
  const items = readWatchlistItems();
  if (!items.some((row) => row.ticker.toUpperCase() === upper)) return;
  writeWatchlistItems(
    items.map((row) =>
      row.ticker.toUpperCase() === upper ? { ...row, targetPrice } : row,
    ),
  );
}

export function isInWatchlist(ticker: string): boolean {
  return readWatchlistItems().some(
    (item) => item.ticker.toUpperCase() === ticker.toUpperCase(),
  );
}

export function toggleWatchlistItem(item: WatchlistItem): boolean {
  const ticker = item.ticker.toUpperCase();
  const current = readWatchlistItems();
  const exists = current.some((row) => row.ticker.toUpperCase() === ticker);

  const next = exists
    ? current.filter((row) => row.ticker.toUpperCase() !== ticker)
    : [...current, { ...item, ticker }];

  writeWatchlistItems(next);

  if (
    typeof Notification !== 'undefined' &&
    Notification.permission === 'granted'
  ) {
    new Notification(exists ? '관심종목 해제' : '관심종목 추가', {
      body: `${item.name || ticker} ${
        exists ? '관심종목에서 삭제했습니다.' : '관심종목에 추가했습니다.'
      }`,
    });
  }

  return !exists;
}
