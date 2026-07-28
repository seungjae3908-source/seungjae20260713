export const UI_LAYOUT_SCHEMA_VERSION = 2 as const;

export type UiPageKey =
  | 'home'
  | 'stocks'
  | 'stock-info'
  | 'tech'
  | 'signal-scan'
  | 'portfolio'
  | 'settings'
  | 'navigation';

export type UiNodeKind =
  | 'section'
  | 'tab'
  | 'button'
  | 'text'
  | 'item'
  | 'card'
  | 'popup';

export type UiSectionWidth = 'full' | 'half' | 'third' | 'auto';
export type UiSectionHeight = 'auto' | 'compact' | 'normal' | 'tall';
export type UiSectionSpacing = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type UiTextAlign = 'left' | 'center' | 'right';
export type UiFontSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type UiFontWeight = 'normal' | 'medium' | 'bold' | 'black';
export type UiRadius = 'none' | 'sm' | 'md' | 'lg' | 'xl' | 'full';
export type UiSourceType = 'none' | 'route' | 'api' | 'component';
export type UiPopupPosition = 'center' | 'bottom' | 'top';

export type UiSection = {
  id: string;
  component: string;
  kind: UiNodeKind;
  parentId?: string | null;
  visible: boolean;
  order: number;
  width: UiSectionWidth;
  height: UiSectionHeight;
  spacing: UiSectionSpacing;
  align: UiTextAlign;
  fontSize: UiFontSize;
  fontWeight: UiFontWeight;
  opacity: 25 | 50 | 75 | 100;
  title?: string;
  route?: string;
  custom?: boolean;
  backgroundColor?: string;
  textColor?: string;
  borderColor?: string;
  radius: UiRadius;
  x: number;
  y: number;
  zIndex: number;
  sourceType: UiSourceType;
  sourceKey?: string;
  sourcePath?: string;
  popupTitle?: string;
  popupContent?: string;
  popupPosition?: UiPopupPosition;
};

export type UiLayout = {
  schemaVersion: typeof UI_LAYOUT_SCHEMA_VERSION;
  pageKey: UiPageKey;
  sections: UiSection[];
};

export type UiLayoutVersion = {
  id: string;
  version: number;
  status: 'draft' | 'published' | 'archived';
  layout: UiLayout;
  created_at?: string;
  published_at?: string | null;
};

export type UiComponentDefinition = {
  component: string;
  label: string;
  description: string;
  kind: UiNodeKind;
  selector?: string;
  titleSelector?: string;
  parentComponent?: string;
  replaceText?: boolean;
};

export type UiPageDefinition = {
  key: UiPageKey;
  label: string;
  description: string;
};

export type UiSourceDefinition = {
  key: string;
  label: string;
  value: string;
};

export const UI_PAGES: UiPageDefinition[] = [
  { key: 'home', label: '홈', description: '시장 요약과 주요 지수 화면' },
  { key: 'stocks', label: '종목', description: '국내·해외·코인 종목 화면' },
  { key: 'stock-info', label: '종목 상세', description: '차트·재무·뉴스·분석 화면' },
  { key: 'tech', label: '기술', description: '기술분석과 도구 화면' },
  { key: 'signal-scan', label: '신호 검색', description: '신호 필터와 결과 화면' },
  { key: 'portfolio', label: '포트폴리오', description: '자산·현금·계획 화면' },
  { key: 'settings', label: '환경 설정', description: '계정·화면·알림·백업 화면' },
  { key: 'navigation', label: '하단 메뉴', description: '하단 버튼과 연결 팝업 카테고리' },
];

export const UI_ROUTE_SOURCES: UiSourceDefinition[] = [
  { key: 'route.home', label: '홈으로 이동', value: '/home' },
  { key: 'route.search', label: '종목 선택으로 이동', value: '/search' },
  { key: 'route.stocks', label: '종목으로 이동', value: '/stocks' },
  { key: 'route.stocks-kr', label: '국내주식으로 이동', value: '/stocks/kr' },
  { key: 'route.stocks-us', label: '해외주식으로 이동', value: '/stocks/us' },
  { key: 'route.coins-spot', label: '코인 현물로 이동', value: '/coins/spot' },
  { key: 'route.coins-futures', label: '코인 선물로 이동', value: '/coins/futures' },
  { key: 'route.watchlist', label: '관심종목으로 이동', value: '/watchlist' },
  { key: 'route.watch-stock-kr', label: '국내주식 관심종목', value: '/watchlist/assets?view=watchlist&asset=stockKR' },
  { key: 'route.watch-stock-us', label: '해외주식 관심종목', value: '/watchlist/assets?view=watchlist&asset=stockUS' },
  { key: 'route.watch-coin-spot', label: '코인 현물 관심종목', value: '/watchlist/assets?view=watchlist&asset=coinSpot' },
  { key: 'route.watch-coin-futures', label: '코인 선물 관심종목', value: '/watchlist/assets?view=watchlist&asset=coinFutures' },
  { key: 'route.alert-stock-kr', label: '국내주식 지정가알림', value: '/watchlist/assets?view=alerts&asset=stockKR' },
  { key: 'route.alert-stock-us', label: '해외주식 지정가알림', value: '/watchlist/assets?view=alerts&asset=stockUS' },
  { key: 'route.alert-coin-spot', label: '코인 현물 지정가알림', value: '/watchlist/assets?view=alerts&asset=coinSpot' },
  { key: 'route.alert-coin-futures', label: '코인 선물 지정가알림', value: '/watchlist/assets?view=alerts&asset=coinFutures' },
  { key: 'route.tech', label: '기술로 이동', value: '/tech' },
  { key: 'route.signal-scan', label: '신호 검색으로 이동', value: '/tech/signal-scan' },
  { key: 'route.chart-stock-kr', label: '국내주식 차트중계', value: '/tech/chart-relay?asset=stockKR&tab=live&focused=1' },
  { key: 'route.chart-stock-us', label: '해외주식 차트중계', value: '/tech/chart-relay?asset=stockUS&tab=live&focused=1' },
  { key: 'route.chart-coin-spot', label: '코인 현물 차트중계', value: '/tech/chart-relay?asset=coinSpot&tab=live&focused=1' },
  { key: 'route.chart-coin-futures', label: '코인 선물 차트중계', value: '/tech/chart-relay?asset=coinFutures&tab=live&focused=1' },
  { key: 'route.auto-trade', label: '자동매매 관리', value: '/tech/auto-trade' },
  { key: 'route.portfolio', label: '포트폴리오로 이동', value: '/portfolio' },
  { key: 'route.info-summary', label: '정보 전체 요약', value: '/portfolio/summary?asset=all&source=info' },
  { key: 'route.portfolio-summary', label: '포트폴리오 전체 요약', value: '/portfolio/summary?asset=all&source=portfolio' },
  { key: 'route.stock-info', label: '종목 정보로 이동', value: '/stock-info' },
  { key: 'route.info-stock-kr', label: '국내주식 정보', value: '/stock-info?asset=stock&market=KR&focused=1' },
  { key: 'route.info-stock-us', label: '해외주식 정보', value: '/stock-info?asset=stock&market=US&focused=1' },
  { key: 'route.info-coin-spot', label: '코인 현물 정보', value: '/stock-info?asset=coin&coinMarket=spot&focused=1' },
  { key: 'route.info-coin-futures', label: '코인 선물 정보', value: '/stock-info?asset=coin&coinMarket=futures&focused=1' },
  { key: 'route.learn', label: '공부로 이동', value: '/learn' },
  { key: 'route.analysis-kr', label: '국내 증시현황', value: '/analysis/KR' },
  { key: 'route.analysis-us', label: '해외 증시현황', value: '/analysis/US' },
  { key: 'route.settings', label: '환경 설정으로 이동', value: '/settings' },
  { key: 'route.more', label: '설정 메뉴로 이동', value: '/more' },
  { key: 'route.account', label: '계정으로 이동', value: '/account' },
];

export const UI_API_SOURCES: UiSourceDefinition[] = [
  { key: 'api.health', label: '서버 상태', value: '/api/health' },
  { key: 'api.summary', label: '시장 요약', value: '/api/market/summary' },
  { key: 'api.search', label: '종목 검색', value: '/api/search?q=삼성전자' },
  { key: 'api.portfolio', label: '포트폴리오 조회', value: '/api/portfolio' },
];

const section = (
  component: string,
  label: string,
  description: string,
  selector: string,
  titleSelector?: string,
): UiComponentDefinition => ({
  component,
  label,
  description,
  kind: 'section',
  selector,
  titleSelector,
});

const child = (
  component: string,
  label: string,
  description: string,
  parentComponent: string,
  selector: string,
  kind: UiNodeKind = 'text',
  replaceText = true,
): UiComponentDefinition => ({
  component,
  label,
  description,
  kind,
  selector,
  parentComponent,
  replaceText,
});

export const UI_COMPONENT_CATALOG: Record<UiPageKey, UiComponentDefinition[]> = {
  home: [
    section('home.header', '상단 제목', '앱 제목과 현재 시간', 'header', 'h1'),
    section('home.market-summary', '오늘의 시장', '시장 선택과 요약 카드', 'main > section:nth-of-type(1)', 'h2'),
    section('home.live-index', '주요 지수', '국내·해외·코인 주요 시세', 'main > section:nth-of-type(2)', 'h3'),
    section('home.market-briefing', '시장 브리핑', '오늘의 시장 분석과 요약', 'main > section:nth-of-type(3)', 'h3'),
    section('home.issues', '주요 이슈', '시장 뉴스와 주요 이슈 목록', 'main > section:nth-of-type(4)', 'h3'),
  ],
  stocks: [
    section('stocks.header', '상단 제목', '종목 화면 제목과 시장 선택', 'header', 'h1'),
    section('stocks.search', '종목 검색', '종목명과 티커 검색 영역', 'main > *:nth-child(1)'),
    section('stocks.market-tabs', '시장 탭', '국내·해외·코인 시장 선택 탭', 'main > *:nth-child(2)'),
    section('stocks.rankings', '순위 선택', '거래량·급등락·추천 순위', 'main > *:nth-child(3)'),
    section('stocks.list', '종목 목록', '검색 결과와 순위 종목 목록', 'main > *:nth-child(4)'),
  ],
  'stock-info': [
    section('stock-info.header', '상단 제목', '종목명과 뒤로가기 영역', 'header', 'h1'),
    section('stock-info.quote', '현재가', '현재가·등락률·거래량', 'main > *:nth-child(1)'),
    section('stock-info.chart', '차트', '현물·선물 실시간 차트', 'main > *:nth-child(2)'),
    section('stock-info.analysis', '기술 분석', '지표·신호·지지저항', 'main > *:nth-child(3)'),
    section('stock-info.financials', '재무 정보', '실적·재무·기업 정보', 'main > *:nth-child(4)'),
    section('stock-info.news', '뉴스·공시', '종목 뉴스와 공시', 'main > *:nth-child(5)'),
  ],
  tech: [
    section('tech.header', '상단 제목', '기술 화면 제목', 'header', 'h1'),
    section('tech.shortcuts', '기술 도구', '차트·신호·분석 바로가기', 'main > *:nth-child(1)'),
    section('tech.signal', '신호 검색', '매수·매도·롱·숏 신호 검색', 'main > *:nth-child(2)'),
    section('tech.chart', '차트 도구', '차트 중계와 실시간 분석', 'main > *:nth-child(3)'),
    section('tech.auto', '자동매매 관리', '관리자용 자동매매 설정', 'main > *:nth-child(4)'),
  ],
  'signal-scan': [
    section('signal-scan.header', '상단 제목', '신호 검색 화면 제목', '[data-ui-edit="signal-scan.header"]', 'h1'),
    child('signal-scan.header.back', '뒤로 버튼', '기술 화면으로 돌아가는 버튼', 'signal-scan.header', '[data-ui-edit="signal-scan.header.back"]', 'button', false),
    child('signal-scan.header.title', '신호검색 제목', '상단의 신호검색 글씨', 'signal-scan.header', '[data-ui-edit="signal-scan.header.title"]'),
    child('signal-scan.header.subtitle', '상단 보조 문구', '단타·스윙 상태에 따라 표시되는 보조 글씨', 'signal-scan.header', '[data-ui-edit="signal-scan.header.subtitle"]'),
    child('signal-scan.header.refresh', '새로고침 버튼', '신호 데이터를 다시 조회하는 버튼', 'signal-scan.header', '[data-ui-edit="signal-scan.header.refresh"]', 'button', false),
    section('signal-scan.filters', '검색 조건', '시장·시간봉·신호 필터', '[data-ui-edit="signal-scan.filters"]'),
    child('signal-scan.mode-tabs', '검색 방식 탭', '단타·스윙·중장기·직접설정 탭 묶음', 'signal-scan.filters', '[data-ui-edit="signal-scan.mode-tabs"]', 'section', false),
    child('signal-scan.mode.scalp', '단타용 · 15분봉', '단타 검색 방식 버튼', 'signal-scan.mode-tabs', '[data-ui-edit="signal-scan.mode.scalp"]', 'tab'),
    child('signal-scan.mode.swing', '스윙', '스윙 검색 방식 버튼', 'signal-scan.mode-tabs', '[data-ui-edit="signal-scan.mode.swing"]', 'tab'),
    child('signal-scan.mode.long', '중장기', '중장기 검색 방식 버튼', 'signal-scan.mode-tabs', '[data-ui-edit="signal-scan.mode.long"]', 'tab'),
    child('signal-scan.mode.custom', '직접 설정', '직접 조건 설정 버튼', 'signal-scan.mode-tabs', '[data-ui-edit="signal-scan.mode.custom"]', 'tab'),
    child('signal-scan.scalp-note', '15분봉 안내 문구', '실제 15분봉·거래량·추세·지지저항 안내 글씨', 'signal-scan.filters', '[data-ui-edit="signal-scan.scalp-note"]'),
    child('signal-scan.condition-panel', '조건 설정 상자', '조건 조합·정렬·제외 설정 상자', 'signal-scan.filters', '[data-ui-edit="signal-scan.condition-panel"]', 'section', false),
    section('signal-scan.summary', '검색 요약', '신호 개수와 상태 요약', 'main > *:nth-child(2)'),
    section('signal-scan.results', '검색 결과', '조건에 맞는 종목 결과', 'main > *:nth-child(3)'),
  ],
  portfolio: [
    section('portfolio.header', '상단 제목', '포트폴리오 화면 제목', 'header', 'h1'),
    section('portfolio.summary', '자산 요약', '총자산·평가손익·수익률', 'main > *:nth-child(1)'),
    section('portfolio.holdings', '보유 종목', '보유 종목과 코인 목록', 'main > *:nth-child(2)'),
    section('portfolio.cash', '현금 설정', '현금과 투자 가능 금액', 'main > *:nth-child(3)'),
    section('portfolio.plan', '투자 계획', '시뮬레이션과 매수 계획', 'main > *:nth-child(4)'),
  ],
  navigation: [
    section('navigation.nav.home', '홈', '하단 홈 버튼', '[data-ui-edit="navigation.nav.home"]', 'span:last-child'),
    section('navigation.nav.markets', '종목', '하단 종목 버튼과 연결 팝업', '[data-ui-edit="navigation.nav.markets"]', 'span:last-child'),
    child('navigation.popup.markets.main.close', '닫기 버튼', '종목 팝업 닫기 버튼', 'navigation.nav.markets', '[data-ui-edit="navigation.popup.markets.main.close"]', 'button', false),
    child('navigation.popup.markets.main.title', '종목 선택', '종목 팝업 제목', 'navigation.nav.markets', '[data-ui-edit="navigation.popup.markets.main.title"]'),
    child('navigation.popup.markets.main.items', '종목 카테고리 목록', '주식·코인 카테고리가 들어가는 영역', 'navigation.nav.markets', '[data-ui-edit="navigation.popup.markets.main.items"]', 'section', false),
    child('navigation.popup.markets.main.item.0', '주식', '주식 하위 카테고리 버튼', 'navigation.popup.markets.main.items', '[data-ui-edit="navigation.popup.markets.main.item.0"]', 'item'),
    child('navigation.popup.markets.main.item.1', '코인', '코인 하위 카테고리 버튼', 'navigation.popup.markets.main.items', '[data-ui-edit="navigation.popup.markets.main.item.1"]', 'item'),
    child('navigation.popup.markets.stocks.close', '주식 팝업 닫기', '주식 선택 팝업 닫기 버튼', 'navigation.popup.markets.main.item.0', '[data-ui-edit="navigation.popup.markets.stocks.close"]', 'button', false),
    child('navigation.popup.markets.stocks.back', '주식 팝업 뒤로', '종목 선택으로 돌아가는 버튼', 'navigation.popup.markets.main.item.0', '[data-ui-edit="navigation.popup.markets.stocks.back"]', 'button', false),
    child('navigation.popup.markets.stocks.title', '주식', '주식 선택 팝업 제목', 'navigation.popup.markets.main.item.0', '[data-ui-edit="navigation.popup.markets.stocks.title"]'),
    child('navigation.popup.markets.stocks.items', '주식 카테고리 목록', '국내·해외주식 버튼 영역', 'navigation.popup.markets.main.item.0', '[data-ui-edit="navigation.popup.markets.stocks.items"]', 'section', false),
    child('navigation.popup.markets.stocks.item.0', '국내주식', '국내주식 화면 연결 버튼', 'navigation.popup.markets.stocks.items', '[data-ui-edit="navigation.popup.markets.stocks.item.0"]', 'item'),
    child('navigation.popup.markets.stocks.item.1', '해외주식', '해외주식 화면 연결 버튼', 'navigation.popup.markets.stocks.items', '[data-ui-edit="navigation.popup.markets.stocks.item.1"]', 'item'),
    child('navigation.popup.markets.coins.close', '코인 팝업 닫기', '코인 선택 팝업 닫기 버튼', 'navigation.popup.markets.main.item.1', '[data-ui-edit="navigation.popup.markets.coins.close"]', 'button', false),
    child('navigation.popup.markets.coins.back', '코인 팝업 뒤로', '종목 선택으로 돌아가는 버튼', 'navigation.popup.markets.main.item.1', '[data-ui-edit="navigation.popup.markets.coins.back"]', 'button', false),
    child('navigation.popup.markets.coins.title', '코인', '코인 선택 팝업 제목', 'navigation.popup.markets.main.item.1', '[data-ui-edit="navigation.popup.markets.coins.title"]'),
    child('navigation.popup.markets.coins.items', '코인 카테고리 목록', '현물·선물 버튼 영역', 'navigation.popup.markets.main.item.1', '[data-ui-edit="navigation.popup.markets.coins.items"]', 'section', false),
    child('navigation.popup.markets.coins.item.0', '코인 현물', '코인 현물 화면 연결 버튼', 'navigation.popup.markets.coins.items', '[data-ui-edit="navigation.popup.markets.coins.item.0"]', 'item'),
    child('navigation.popup.markets.coins.item.1', '코인 선물', '코인 선물 화면 연결 버튼', 'navigation.popup.markets.coins.items', '[data-ui-edit="navigation.popup.markets.coins.item.1"]', 'item'),
    section('navigation.nav.watch', '관심', '하단 관심 버튼', '[data-ui-edit="navigation.nav.watch"]', 'span:last-child'),
    section('navigation.nav.tech', '기술', '하단 기술 버튼', '[data-ui-edit="navigation.nav.tech"]', 'span:last-child'),
    section('navigation.nav.info', '정보', '하단 정보 버튼', '[data-ui-edit="navigation.nav.info"]', 'span:last-child'),
    section('navigation.nav.settings', '설정', '하단 설정 버튼', '[data-ui-edit="navigation.nav.settings"]', 'span:last-child'),
  ],
  settings: [
    section('settings.header', '상단 제목', '환경 설정 화면 제목', 'header', 'h1'),
    section('settings.account-assets', '계정 · 자산', '로그인과 포트폴리오 영역', 'main > details:nth-of-type(1)', 'summary span:first-child'),
    section('settings.screen', '화면 설정', '다크모드와 화면 표시 설정', 'main > details:nth-of-type(2)', 'summary span:first-child'),
    section('settings.notifications', '휴대폰 알림', '브라우저와 푸시 알림 영역', 'main > details:nth-of-type(3)', 'summary span:first-child'),
    section('settings.alert-types', '관심종목 알림 종류', '뉴스·공시·등락률 알림 선택', 'main > details:nth-of-type(4)', 'summary span:first-child'),
    section('settings.admin-tools', '관리자 수정', '관리자 UI 편집 진입 영역', 'main > section:nth-of-type(1)', 'p:first-of-type'),
    section('settings.ai-repair', 'AI 복구센터', '관리자 전용 점검과 복구 영역', 'main > section:nth-of-type(2)'),
    section('settings.backup', '서버 자동백업 / 복원', '서버 백업과 복원 영역', 'main > details:nth-of-type(5)', 'summary span:first-child'),
    section('settings.footer', '하단 표시', '제작자 표시 영역', 'main > p:last-of-type'),
  ],
};

export function getUiPageDefinition(pageKey: UiPageKey) {
  return UI_PAGES.find((page) => page.key === pageKey) ?? UI_PAGES[0];
}

function baseSection(
  component: string,
  kind: UiNodeKind,
  title: string,
  order: number,
  custom: boolean,
  parentId: string | null = null,
): UiSection {
  return {
    id: custom ? `${component}.${Date.now().toString(36)}.${order}` : component,
    component,
    kind,
    parentId,
    visible: true,
    order,
    width: 'full',
    height: 'auto',
    spacing: 'md',
    align: 'center',
    fontSize: 'md',
    fontWeight: kind === 'text' ? 'bold' : 'black',
    opacity: 100,
    title,
    custom,
    backgroundColor: '',
    textColor: '',
    borderColor: '',
    radius: 'xl',
    x: 0,
    y: 0,
    zIndex: 0,
    sourceType: 'none',
    sourceKey: '',
    sourcePath: '',
    popupTitle: kind === 'popup' ? '새 팝업' : '',
    popupContent: kind === 'popup' ? '팝업 내용을 입력하세요.' : '',
    popupPosition: 'center',
  };
}

export function createDefaultUiLayout(
  pageKey: UiPageKey = 'settings',
): UiLayout {
  return {
    schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
    pageKey,
    sections: UI_COMPONENT_CATALOG[pageKey].map((item, order) =>
      baseSection(
        item.component,
        item.kind,
        item.label,
        order,
        false,
        item.parentComponent ?? null,
      ),
    ),
  };
}

function safeId(value: unknown, fallback: string) {
  const id = String(value ?? '').trim();
  return /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) ? id : fallback;
}

function safeRoute(value: unknown) {
  const route = String(value ?? '').trim();
  return route.startsWith('/') ? route.slice(0, 200) : undefined;
}

function safeColor(value: unknown) {
  const color = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(color) ? color.toUpperCase() : '';
}

function clampNumber(value: unknown, min: number, max: number, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

export function normalizeUiLayout(
  value: unknown,
  pageKey: UiPageKey = 'settings',
): UiLayout {
  const fallback = createDefaultUiLayout(pageKey);
  if (!value || typeof value !== 'object') return fallback;

  const source = value as { sections?: unknown[] };
  if (!Array.isArray(source.sections)) return fallback;

  const allowed = new Set(
    UI_COMPONENT_CATALOG[pageKey].map((item) => item.component),
  );
  const seen = new Set<string>();
  const sections: UiSection[] = [];

  source.sections.slice(0, 80).forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Partial<UiSection>;
    const component = String(item.component ?? '').trim();
    const custom = item.custom === true || component.startsWith('custom.');
    if ((!custom && !allowed.has(component)) || seen.has(String(item.id))) return;

    const id = safeId(
      item.id,
      custom ? `custom.node.${Date.now().toString(36)}.${index}` : component,
    );
    seen.add(id);

    const width: UiSectionWidth =
      item.width === 'half' || item.width === 'third' || item.width === 'auto'
        ? item.width
        : 'full';
    const height: UiSectionHeight =
      item.height === 'compact' || item.height === 'normal' || item.height === 'tall'
        ? item.height
        : 'auto';
    const spacing: UiSectionSpacing =
      item.spacing === 'none' ||
      item.spacing === 'xs' ||
      item.spacing === 'sm' ||
      item.spacing === 'lg' ||
      item.spacing === 'xl'
        ? item.spacing
        : 'md';
    const align: UiTextAlign =
      item.align === 'left' || item.align === 'right' ? item.align : 'center';
    const fontSize: UiFontSize =
      item.fontSize === 'xs' ||
      item.fontSize === 'sm' ||
      item.fontSize === 'lg' ||
      item.fontSize === 'xl' ||
      item.fontSize === '2xl'
        ? item.fontSize
        : 'md';
    const fontWeight: UiFontWeight =
      item.fontWeight === 'normal' ||
      item.fontWeight === 'medium' ||
      item.fontWeight === 'bold'
        ? item.fontWeight
        : 'black';
    const opacity =
      item.opacity === 25 || item.opacity === 50 || item.opacity === 75
        ? item.opacity
        : 100;
    const kind: UiNodeKind =
      item.kind === 'tab' ||
      item.kind === 'button' ||
      item.kind === 'text' ||
      item.kind === 'item' ||
      item.kind === 'card' ||
      item.kind === 'popup'
        ? item.kind
        : 'section';
    const sourceType: UiSourceType =
      item.sourceType === 'route' ||
      item.sourceType === 'api' ||
      item.sourceType === 'component'
        ? item.sourceType
        : 'none';
    const radius: UiRadius =
      item.radius === 'none' ||
      item.radius === 'sm' ||
      item.radius === 'md' ||
      item.radius === 'lg' ||
      item.radius === 'full'
        ? item.radius
        : 'xl';
    const popupPosition: UiPopupPosition =
      item.popupPosition === 'bottom' || item.popupPosition === 'top'
        ? item.popupPosition
        : 'center';

    sections.push({
      id,
      component: custom ? component || `custom.${kind}` : component,
      kind,
      parentId: typeof item.parentId === 'string' ? item.parentId : null,
      visible: item.visible !== false,
      order: Number.isFinite(Number(item.order)) ? Number(item.order) : index,
      width,
      height,
      spacing,
      align,
      fontSize,
      fontWeight,
      opacity,
      title:
        typeof item.title === 'string'
          ? item.title.trim().slice(0, 120)
          : undefined,
      route: safeRoute(item.route),
      custom,
      backgroundColor: safeColor(item.backgroundColor),
      textColor: safeColor(item.textColor),
      borderColor: safeColor(item.borderColor),
      radius,
      x: Math.round(clampNumber(item.x, -240, 240)),
      y: Math.round(clampNumber(item.y, -400, 400)),
      zIndex: Math.round(clampNumber(item.zIndex, 0, 50)),
      sourceType,
      sourceKey:
        typeof item.sourceKey === 'string' ? item.sourceKey.slice(0, 100) : '',
      sourcePath:
        sourceType === 'api'
          ? safeRoute(item.sourcePath)
          : sourceType === 'route'
            ? safeRoute(item.sourcePath ?? item.route)
            : '',
      popupTitle:
        typeof item.popupTitle === 'string'
          ? item.popupTitle.trim().slice(0, 120)
          : '',
      popupContent:
        typeof item.popupContent === 'string'
          ? item.popupContent.trim().slice(0, 2000)
          : '',
      popupPosition,
    });
  });

  const byComponent = new Map(sections.map((item) => [item.component, item]));
  for (const definition of UI_COMPONENT_CATALOG[pageKey]) {
    if (!definition.parentComponent || byComponent.has(definition.component)) continue;
    const parent = byComponent.get(definition.parentComponent);
    if (!parent) continue;
    const added = baseSection(
      definition.component,
      definition.kind,
      definition.label,
      sections.length,
      false,
      parent.id,
    );
    sections.push(added);
    byComponent.set(added.component, added);
  }

  const validIds = new Set(sections.map((item) => item.id));
  sections.forEach((item) => {
    if (item.parentId && !validIds.has(item.parentId)) item.parentId = null;
  });

  sections.sort((a, b) => a.order - b.order);
  sections.forEach((item, order) => {
    item.order = order;
  });

  return {
    schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
    pageKey,
    sections,
  };
}

export function moveUiSection(
  layout: UiLayout,
  sectionId: string,
  direction: -1 | 1,
): UiLayout {
  const sections = layout.sections.map((section) => ({ ...section }));
  const source = sections.find((section) => section.id === sectionId);
  if (!source) return { ...layout, sections };
  const siblings = sections
    .filter((section) => section.parentId === source.parentId)
    .sort((a, b) => a.order - b.order);
  const index = siblings.findIndex((section) => section.id === sectionId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= siblings.length) return { ...layout, sections };
  const targetSection = siblings[target];
  const sourceOrder = source.order;
  source.order = targetSection.order;
  targetSection.order = sourceOrder;
  sections.sort((a, b) => a.order - b.order);
  sections.forEach((item, order) => {
    item.order = order;
  });
  return { ...layout, sections };
}

export function moveUiSectionTo(
  layout: UiLayout,
  sectionId: string,
  targetId: string,
): UiLayout {
  const sections = layout.sections.map((section) => ({ ...section }));
  const from = sections.findIndex((section) => section.id === sectionId);
  const target = sections.findIndex((section) => section.id === targetId);
  if (from < 0 || target < 0 || from === target) return layout;
  if (sections[from].parentId !== sections[target].parentId) return layout;
  const [section] = sections.splice(from, 1);
  sections.splice(target, 0, section);
  sections.forEach((item, order) => {
    item.order = order;
  });
  return { ...layout, sections };
}

export function removeUiSection(layout: UiLayout, sectionId: string): UiLayout {
  const target = layout.sections.find((section) => section.id === sectionId);
  if (!target) return layout;
  const affected = new Set<string>([sectionId]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const section of layout.sections) {
      if (section.parentId && affected.has(section.parentId) && !affected.has(section.id)) {
        affected.add(section.id);
        changed = true;
      }
    }
  }
  const sections = target.custom
    ? layout.sections.filter((section) => !affected.has(section.id))
    : layout.sections.map((section) =>
        affected.has(section.id) ? { ...section, visible: false } : { ...section },
      );
  sections.forEach((section, order) => {
    section.order = order;
  });
  return { ...layout, sections };
}

export function duplicateUiSection(layout: UiLayout, sectionId: string): UiLayout {
  const source = layout.sections.find((section) => section.id === sectionId);
  if (!source) return layout;
  const copy: UiSection = {
    ...source,
    id: `custom.copy.${Date.now().toString(36)}`,
    component: `custom.${source.kind}`,
    custom: true,
    title: `${source.title ?? '항목'} 복사본`,
    order: source.order + 1,
  };
  const sections = layout.sections.map((section) => ({ ...section }));
  sections.splice(source.order + 1, 0, copy);
  sections.forEach((item, order) => {
    item.order = order;
  });
  return { ...layout, sections };
}

export function addCatalogSection(
  layout: UiLayout,
  component: string,
): UiLayout {
  const existing = layout.sections.find((section) => section.component === component);
  if (existing) {
    const sections = layout.sections.map((section) =>
      section.id === existing.id ? { ...section, visible: true } : { ...section },
    );
    let parentId = existing.parentId;
    while (parentId) {
      const parent = sections.find((section) => section.id === parentId);
      if (!parent) break;
      parent.visible = true;
      parentId = parent.parentId ?? null;
    }
    return { ...layout, sections };
  }
  const definition = UI_COMPONENT_CATALOG[layout.pageKey].find(
    (item) => item.component === component,
  );
  if (!definition) return layout;
  const parent = definition.parentComponent
    ? layout.sections.find((section) => section.component === definition.parentComponent)
    : null;
  return {
    ...layout,
    sections: [
      ...layout.sections,
      baseSection(
        definition.component,
        definition.kind,
        definition.label,
        layout.sections.length,
        false,
        parent?.id ?? null,
      ),
    ],
  };
}

export function addCustomUiSection(
  layout: UiLayout,
  kind: Exclude<UiNodeKind, 'section'> = 'button',
  parentId: string | null = null,
): UiLayout {
  const labels: Record<Exclude<UiNodeKind, 'section'>, string> = {
    tab: '새 탭',
    button: '새 버튼',
    text: '새 글씨',
    item: '새 항목',
    card: '새 카드',
    popup: '새 팝업 버튼',
  };
  const section = baseSection(
    `custom.${kind}`,
    kind,
    labels[kind],
    layout.sections.length,
    true,
    parentId,
  );
  if (kind === 'route' as UiNodeKind) section.sourceType = 'route';
  return { ...layout, sections: [...layout.sections, section] };
}
