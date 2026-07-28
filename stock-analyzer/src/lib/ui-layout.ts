export const UI_LAYOUT_SCHEMA_VERSION = 2 as const;

export type UiPageKey =
  | 'home'
  | 'stocks'
  | 'stock-info'
  | 'tech'
  | 'signal-scan'
  | 'portfolio'
  | 'settings';

export type UiNodeKind =
  | 'section'
  | 'tab'
  | 'button'
  | 'text'
  | 'item'
  | 'custom';

export type UiSectionWidth = 'full' | 'half' | 'third' | 'auto';
export type UiSectionHeight = 'auto' | 'compact' | 'normal' | 'tall';
export type UiSectionSpacing = 'none' | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
export type UiTextAlign = 'left' | 'center' | 'right';
export type UiFontSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type UiFontWeight = 'normal' | 'medium' | 'bold' | 'black';

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
};

export type UiPageDefinition = {
  key: UiPageKey;
  label: string;
  description: string;
};

export const UI_PAGES: UiPageDefinition[] = [
  { key: 'home', label: '홈', description: '시장 요약과 주요 지수 화면' },
  { key: 'stocks', label: '종목', description: '국내·해외·코인 종목 화면' },
  { key: 'stock-info', label: '종목 상세', description: '차트·재무·뉴스·분석 화면' },
  { key: 'tech', label: '기술', description: '기술분석과 도구 화면' },
  { key: 'signal-scan', label: '신호 검색', description: '신호 필터와 결과 화면' },
  { key: 'portfolio', label: '포트폴리오', description: '자산·현금·계획 화면' },
  { key: 'settings', label: '환경 설정', description: '계정·화면·알림·백업 화면' },
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
    section('signal-scan.header', '상단 제목', '신호 검색 화면 제목', 'header', 'h1'),
    section('signal-scan.filters', '검색 조건', '시장·시간봉·신호 필터', 'main > *:nth-child(1)'),
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

export function createDefaultUiLayout(
  pageKey: UiPageKey = 'settings',
): UiLayout {
  return {
    schemaVersion: UI_LAYOUT_SCHEMA_VERSION,
    pageKey,
    sections: UI_COMPONENT_CATALOG[pageKey].map((item, order) => ({
      id: item.component,
      component: item.component,
      kind: item.kind,
      parentId: null,
      visible: true,
      order,
      width: 'full',
      height: 'auto',
      spacing: 'md',
      align: 'center',
      fontSize: 'md',
      fontWeight: 'black',
      opacity: 100,
      title: item.label,
      custom: false,
    })),
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

  source.sections.forEach((raw, index) => {
    if (!raw || typeof raw !== 'object') return;
    const item = raw as Partial<UiSection>;
    const component = String(item.component ?? '').trim();
    const custom = item.custom === true || component.startsWith('custom.');
    if ((!custom && !allowed.has(component)) || seen.has(String(item.id))) return;

    const id = safeId(item.id, custom ? `custom.${Date.now()}.${index}` : component);
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

    sections.push({
      id,
      component: custom ? component || 'custom.card' : component,
      kind:
        item.kind === 'tab' ||
        item.kind === 'button' ||
        item.kind === 'text' ||
        item.kind === 'item' ||
        item.kind === 'custom'
          ? item.kind
          : 'section',
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
    });
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
  const index = sections.findIndex((section) => section.id === sectionId);
  const target = index + direction;

  if (index < 0 || target < 0 || target >= sections.length) {
    return { ...layout, sections };
  }

  const [section] = sections.splice(index, 1);
  sections.splice(target, 0, section);
  sections.forEach((item, order) => {
    item.order = order;
  });

  return { ...layout, sections };
}

export function removeUiSection(layout: UiLayout, sectionId: string): UiLayout {
  const sections = layout.sections
    .filter((section) => section.id !== sectionId)
    .map((section, order) => ({ ...section, order }));
  return { ...layout, sections };
}

export function addCatalogSection(
  layout: UiLayout,
  component: string,
): UiLayout {
  if (layout.sections.some((section) => section.component === component)) {
    return layout;
  }
  const definition = UI_COMPONENT_CATALOG[layout.pageKey].find(
    (item) => item.component === component,
  );
  if (!definition) return layout;
  return {
    ...layout,
    sections: [
      ...layout.sections,
      {
        id: definition.component,
        component: definition.component,
        kind: definition.kind,
        parentId: null,
        visible: true,
        order: layout.sections.length,
        width: 'full',
        height: 'auto',
        spacing: 'md',
        align: 'center',
        fontSize: 'md',
        fontWeight: 'black',
        opacity: 100,
        title: definition.label,
        custom: false,
      },
    ],
  };
}

export function addCustomUiSection(
  layout: UiLayout,
  kind: Exclude<UiNodeKind, 'section'> = 'button',
): UiLayout {
  const id = `custom.${kind}.${Date.now().toString(36)}`;
  const labels: Record<string, string> = {
    tab: '새 탭',
    button: '새 버튼',
    text: '새 글씨',
    item: '새 항목',
    custom: '새 카드',
  };
  return {
    ...layout,
    sections: [
      ...layout.sections,
      {
        id,
        component: `custom.${kind}`,
        kind,
        parentId: null,
        visible: true,
        order: layout.sections.length,
        width: 'full',
        height: 'auto',
        spacing: 'md',
        align: 'center',
        fontSize: 'md',
        fontWeight: 'bold',
        opacity: 100,
        title: labels[kind] ?? '새 항목',
        route: kind === 'button' || kind === 'tab' || kind === 'item' ? '/' : undefined,
        custom: true,
      },
    ],
  };
}
