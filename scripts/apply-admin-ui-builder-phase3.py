#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"[{label}] expected exactly one match, found {count}: {path}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


# ---------------------------------------------------------------------------
# ui-layout.ts: navigation page, nested catalog, safe delete/restore, children
# ---------------------------------------------------------------------------
ui_layout = ROOT / "stock-analyzer/src/lib/ui-layout.ts"

replace_once(
    ui_layout,
    """export type UiPageKey =
  | 'home'
  | 'stocks'
  | 'stock-info'
  | 'tech'
  | 'signal-scan'
  | 'portfolio'
  | 'settings';""",
    """export type UiPageKey =
  | 'home'
  | 'stocks'
  | 'stock-info'
  | 'tech'
  | 'signal-scan'
  | 'portfolio'
  | 'settings'
  | 'navigation';""",
    "ui page key",
)

replace_once(
    ui_layout,
    """export type UiComponentDefinition = {
  component: string;
  label: string;
  description: string;
  kind: UiNodeKind;
  selector?: string;
  titleSelector?: string;
};""",
    """export type UiComponentDefinition = {
  component: string;
  label: string;
  description: string;
  kind: UiNodeKind;
  selector?: string;
  titleSelector?: string;
  parentComponent?: string;
  replaceText?: boolean;
};""",
    "component definition",
)

replace_once(
    ui_layout,
    """  { key: 'portfolio', label: '포트폴리오', description: '자산·현금·계획 화면' },
  { key: 'settings', label: '환경 설정', description: '계정·화면·알림·백업 화면' },
];""",
    """  { key: 'portfolio', label: '포트폴리오', description: '자산·현금·계획 화면' },
  { key: 'settings', label: '환경 설정', description: '계정·화면·알림·백업 화면' },
  { key: 'navigation', label: '하단 메뉴', description: '하단 버튼과 연결 팝업 카테고리' },
];""",
    "page definitions",
)

route_old = """export const UI_ROUTE_SOURCES: UiSourceDefinition[] = [
  { key: 'route.home', label: '홈으로 이동', value: '/home' },
  { key: 'route.stocks', label: '종목으로 이동', value: '/stocks' },
  { key: 'route.watchlist', label: '관심종목으로 이동', value: '/watchlist' },
  { key: 'route.tech', label: '기술로 이동', value: '/tech' },
  { key: 'route.signal-scan', label: '신호 검색으로 이동', value: '/tech/signal-scan' },
  { key: 'route.portfolio', label: '포트폴리오로 이동', value: '/portfolio' },
  { key: 'route.settings', label: '환경 설정으로 이동', value: '/settings' },
  { key: 'route.account', label: '계정으로 이동', value: '/account' },
];"""

route_new = """export const UI_ROUTE_SOURCES: UiSourceDefinition[] = [
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
];"""
replace_once(ui_layout, route_old, route_new, "route sources")

replace_once(
    ui_layout,
    """const section = (
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
});""",
    """const section = (
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
});""",
    "catalog helpers",
)

signal_old = """  'signal-scan': [
    section('signal-scan.header', '상단 제목', '신호 검색 화면 제목', 'header', 'h1'),
    section('signal-scan.filters', '검색 조건', '시장·시간봉·신호 필터', 'main > *:nth-child(1)'),
    section('signal-scan.summary', '검색 요약', '신호 개수와 상태 요약', 'main > *:nth-child(2)'),
    section('signal-scan.results', '검색 결과', '조건에 맞는 종목 결과', 'main > *:nth-child(3)'),
  ],"""

signal_new = """  'signal-scan': [
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
  ],"""
replace_once(ui_layout, signal_old, signal_new, "signal scan catalog")

navigation_catalog = """  navigation: [
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
"""
replace_once(
    ui_layout,
    """  settings: [
""",
    navigation_catalog + """  settings: [
""",
    "navigation catalog",
)

replace_once(
    ui_layout,
    """function baseSection(
  component: string,
  kind: UiNodeKind,
  title: string,
  order: number,
  custom: boolean,
): UiSection {
  return {
    id: custom ? `${component}.${Date.now().toString(36)}.${order}` : component,
    component,
    kind,
    parentId: null,""",
    """function baseSection(
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
    parentId,""",
    "base section parent",
)

replace_once(
    ui_layout,
    """    sections: UI_COMPONENT_CATALOG[pageKey].map((item, order) =>
      baseSection(item.component, item.kind, item.label, order, false),
    ),""",
    """    sections: UI_COMPONENT_CATALOG[pageKey].map((item, order) =>
      baseSection(
        item.component,
        item.kind,
        item.label,
        order,
        false,
        item.parentComponent ?? null,
      ),
    ),""",
    "default layout parents",
)

replace_once(
    ui_layout,
    """  sections.sort((a, b) => a.order - b.order);
  sections.forEach((item, order) => {
    item.order = order;
  });

  return {
""",
    """  const byComponent = new Map(sections.map((item) => [item.component, item]));
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
""",
    "normalize nested catalog",
)

replace_once(
    ui_layout,
    """export function moveUiSection(
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
}""",
    """export function moveUiSection(
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
}""",
    "move siblings",
)

replace_once(
    ui_layout,
    """  if (from < 0 || target < 0 || from === target) return layout;
  const [section] = sections.splice(from, 1);""",
    """  if (from < 0 || target < 0 || from === target) return layout;
  if (sections[from].parentId !== sections[target].parentId) return layout;
  const [section] = sections.splice(from, 1);""",
    "move target parent guard",
)

replace_once(
    ui_layout,
    """export function removeUiSection(layout: UiLayout, sectionId: string): UiLayout {
  const sections = layout.sections
    .filter((section) => section.id !== sectionId)
    .map((section, order) => ({ ...section, order }));
  return { ...layout, sections };
}""",
    """export function removeUiSection(layout: UiLayout, sectionId: string): UiLayout {
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
}""",
    "remove visibility",
)

replace_once(
    ui_layout,
    """export function addCatalogSection(
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
      baseSection(
        definition.component,
        definition.kind,
        definition.label,
        layout.sections.length,
        false,
      ),
    ],
  };
}""",
    """export function addCatalogSection(
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
}""",
    "restore catalog",
)

replace_once(
    ui_layout,
    """export function addCustomUiSection(
  layout: UiLayout,
  kind: Exclude<UiNodeKind, 'section'> = 'button',
): UiLayout {""",
    """export function addCustomUiSection(
  layout: UiLayout,
  kind: Exclude<UiNodeKind, 'section'> = 'button',
  parentId: string | null = null,
): UiLayout {""",
    "custom section parent signature",
)

replace_once(
    ui_layout,
    """    layout.sections.length,
    true,
  );""",
    """    layout.sections.length,
    true,
    parentId,
  );""",
    "custom section parent call",
)

# ---------------------------------------------------------------------------
# Internal editor component
# ---------------------------------------------------------------------------
internal_editor = r'''import { useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Eye,
  EyeOff,
  Plus,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react';
import {
  UI_API_SOURCES,
  UI_COMPONENT_CATALOG,
  UI_ROUTE_SOURCES,
  addCatalogSection,
  addCustomUiSection,
  removeUiSection,
  type UiLayout,
  type UiNodeKind,
  type UiSection,
  type UiSourceType,
} from '@/lib/ui-layout';
import { cn } from '@/lib/utils';

const inputClass =
  'h-11 w-full rounded-xl border border-card-border bg-background px-3 text-sm font-bold text-foreground';
const labelClass = 'mb-1.5 block text-xs font-black text-muted-foreground';

type Props = {
  layout: UiLayout;
  parentId: string;
  onChange: (layout: UiLayout) => void;
  onClose: () => void;
};

export default function UiInternalEditor({ layout, parentId, onChange, onClose }: Props) {
  const [stack, setStack] = useState<string[]>([parentId]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const currentParentId = stack[stack.length - 1];
  const currentParent = layout.sections.find((section) => section.id === currentParentId) ?? null;

  useEffect(() => {
    setStack([parentId]);
    setSelectedId(null);
  }, [parentId]);

  const children = useMemo(
    () =>
      layout.sections
        .filter((section) => section.parentId === currentParentId)
        .sort((a, b) => a.order - b.order),
    [currentParentId, layout.sections],
  );

  const selected =
    layout.sections.find((section) => section.id === selectedId) ?? children[0] ?? null;

  useEffect(() => {
    if (!selectedId && children[0]) setSelectedId(children[0].id);
    if (selectedId && !children.some((item) => item.id === selectedId)) {
      setSelectedId(children[0]?.id ?? null);
    }
  }, [children, selectedId]);

  const update = (id: string, patch: Partial<UiSection>) => {
    onChange({
      ...layout,
      sections: layout.sections.map((section) =>
        section.id === id ? { ...section, ...patch } : section,
      ),
    });
  };

  const addCustom = (kind: Exclude<UiNodeKind, 'section'>) => {
    const next = addCustomUiSection(layout, kind, currentParentId);
    const created = next.sections[next.sections.length - 1];
    onChange(next);
    setSelectedId(created.id);
  };

  const directCatalog = UI_COMPONENT_CATALOG[layout.pageKey].filter(
    (definition) => definition.parentComponent === currentParent?.component,
  );
  const hiddenCatalog = directCatalog.filter((definition) => {
    const found = layout.sections.find((section) => section.component === definition.component);
    return !found || !found.visible;
  });

  const hasChildren = (id: string) =>
    layout.sections.some((section) => section.parentId === id);

  return (
    <div className="absolute inset-0 z-[70] flex items-end bg-black/70" onClick={onClose}>
      <section
        className="flex max-h-[94%] w-full flex-col rounded-t-[2rem] border-t border-card-border bg-background"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="shrink-0 border-b border-card-border p-4">
          <div className="mx-auto flex max-w-md items-center gap-3">
            {stack.length > 1 ? (
              <button
                type="button"
                onClick={() => {
                  setStack((current) => current.slice(0, -1));
                  setSelectedId(null);
                }}
                className="rounded-xl border border-card-border p-2"
              >
                <ArrowLeft className="h-5 w-5" />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-lg font-black">{currentParent?.title ?? '내부 항목'}</h2>
              <p className="text-xs font-bold text-muted-foreground">
                글씨·버튼·카테고리를 선택해 수정하거나 숨길 수 있습니다.
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-xl border border-card-border p-2">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4 pb-12">
          <div className="mx-auto max-w-md space-y-4">
            <div className="space-y-2">
              {children.length ? (
                children.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSelectedId(item.id)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-2xl border bg-card p-3 text-left',
                      selected?.id === item.id
                        ? 'border-primary ring-2 ring-primary/20'
                        : 'border-card-border',
                      !item.visible && 'opacity-45',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-black">
                        {item.title || '이름 없는 내부 항목'}
                      </span>
                      <span className="mt-1 block text-[10px] font-bold text-muted-foreground">
                        {item.custom ? '사용자 추가' : '기존 화면 요소'} · {item.visible ? '표시 중' : '숨김'}
                      </span>
                    </span>
                    {hasChildren(item.id) ? (
                      <span
                        role="button"
                        tabIndex={0}
                        onClick={(event) => {
                          event.stopPropagation();
                          setStack((current) => [...current, item.id]);
                          setSelectedId(null);
                        }}
                        className="flex items-center gap-1 rounded-xl border border-primary/30 px-2.5 py-2 text-[10px] font-black text-primary"
                      >
                        내부 <ChevronRight className="h-3.5 w-3.5" />
                      </span>
                    ) : null}
                  </button>
                ))
              ) : (
                <p className="rounded-2xl bg-secondary p-4 text-center text-xs font-bold text-muted-foreground">
                  내부 항목이 없습니다. 아래에서 글씨나 카테고리를 추가하세요.
                </p>
              )}
            </div>

            {selected ? (
              <section className="space-y-3 rounded-3xl border border-card-border bg-card p-4">
                <label>
                  <span className={labelClass}>이름 / 실제 표시 글씨</span>
                  <input
                    value={selected.title ?? ''}
                    onChange={(event) => update(selected.id, { title: event.target.value })}
                    className={inputClass}
                  />
                </label>

                <button
                  type="button"
                  onClick={() => update(selected.id, { visible: !selected.visible })}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-card-border p-3 text-sm font-black"
                >
                  {selected.visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  {selected.visible ? '숨기기' : '다시 표시'}
                </button>

                <label>
                  <span className={labelClass}>버튼 연결 종류</span>
                  <select
                    value={selected.sourceType}
                    onChange={(event) =>
                      update(selected.id, {
                        sourceType: event.target.value as UiSourceType,
                        sourceKey: '',
                        sourcePath: '',
                      })
                    }
                    className={inputClass}
                  >
                    <option value="none">기존 동작 유지 / 연결 없음</option>
                    <option value="route">기존 화면으로 이동</option>
                    <option value="api">기존 조회 API</option>
                  </select>
                </label>

                {selected.sourceType === 'route' ? (
                  <label>
                    <span className={labelClass}>연결할 카테고리 화면</span>
                    <select
                      value={selected.sourceKey ?? ''}
                      onChange={(event) => {
                        const found = UI_ROUTE_SOURCES.find((item) => item.key === event.target.value);
                        update(selected.id, {
                          sourceKey: event.target.value,
                          sourcePath: found?.value ?? '',
                        });
                      }}
                      className={inputClass}
                    >
                      <option value="">선택하세요</option>
                      {UI_ROUTE_SOURCES.map((item) => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}

                {selected.sourceType === 'api' ? (
                  <label>
                    <span className={labelClass}>연결할 조회 API</span>
                    <select
                      value={selected.sourceKey ?? ''}
                      onChange={(event) => {
                        const found = UI_API_SOURCES.find((item) => item.key === event.target.value);
                        update(selected.id, {
                          sourceKey: event.target.value,
                          sourcePath: found?.value ?? '',
                        });
                      }}
                      className={inputClass}
                    >
                      <option value="">선택하세요</option>
                      {UI_API_SOURCES.map((item) => (
                        <option key={item.key} value={item.key}>{item.label}</option>
                      ))}
                    </select>
                  </label>
                ) : null}

                <button
                  type="button"
                  onClick={() => {
                    if (!window.confirm(`“${selected.title ?? '내부 항목'}”을 삭제할까요?`)) return;
                    onChange(removeUiSection(layout, selected.id));
                  }}
                  className="flex w-full items-center justify-center gap-2 rounded-xl border border-negative/40 bg-negative/10 p-3 text-sm font-black text-negative"
                >
                  <Trash2 className="h-4 w-4" />
                  {selected.custom ? '완전히 삭제' : '기존 화면에서 삭제(숨김)'}
                </button>
              </section>
            ) : null}

            <section className="rounded-3xl border border-card-border bg-card p-4">
              <h3 className="text-sm font-black">이 영역 내부에 추가</h3>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {([
                  ['text', '글씨'],
                  ['button', '버튼'],
                  ['item', '카테고리'],
                ] as const).map(([kind, label]) => (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => addCustom(kind)}
                    className="flex flex-col items-center gap-1 rounded-xl border border-primary/30 bg-primary/10 p-3 text-xs font-black text-primary"
                  >
                    <Plus className="h-4 w-4" />{label}
                  </button>
                ))}
              </div>

              {hiddenCatalog.length ? (
                <div className="mt-4 space-y-2">
                  <p className="text-xs font-black text-muted-foreground">삭제한 기존 항목 복원</p>
                  {hiddenCatalog.map((definition) => (
                    <button
                      key={definition.component}
                      type="button"
                      onClick={() => {
                        const next = addCatalogSection(layout, definition.component);
                        onChange(next);
                        const restored = next.sections.find((item) => item.component === definition.component);
                        setSelectedId(restored?.id ?? null);
                      }}
                      className="flex w-full items-center justify-between rounded-xl border border-card-border p-3 text-left text-sm font-black"
                    >
                      {definition.label}
                      <RotateCcw className="h-4 w-4 text-primary" />
                    </button>
                  ))}
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}
'''
write(ROOT / "stock-analyzer/src/components/ui-internal-editor.tsx", internal_editor)

# ---------------------------------------------------------------------------
# admin-ui-builder.tsx: top-level canvas only + internal editor entry
# ---------------------------------------------------------------------------
admin = ROOT / "stock-analyzer/src/pages/admin-ui-builder.tsx"

replace_once(
    admin,
    """import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';""",
    """import { authorizedFetch } from '@/lib/auth-fetch';
import { useAuth } from '@/lib/auth';
import UiInternalEditor from '@/components/ui-internal-editor';""",
    "admin internal import",
)

replace_once(
    admin,
    """  const [historyOpen, setHistoryOpen] = useState(false);
  const [propertyTab,""",
    """  const [historyOpen, setHistoryOpen] = useState(false);
  const [internalParentId, setInternalParentId] = useState<string | null>(null);
  const [propertyTab,""",
    "admin internal state",
)

replace_once(
    admin,
    """  const availableCatalog = catalog.filter(
    (definition) =>
      !layout.sections.some((section) => section.component === definition.component),
  );""",
    """  const availableCatalog = catalog.filter((definition) => {
    if (definition.parentComponent) return false;
    const found = layout.sections.find((section) => section.component === definition.component);
    return !found || !found.visible;
  });
  const canvasSections = layout.sections
    .filter((section) => !section.parentId && section.visible)
    .sort((a, b) => a.order - b.order);""",
    "admin canvas sections",
)

replace_once(
    admin,
    """      setSelectedId(normalized.sections[0]?.id ?? null);
      setStatus('');""",
    """      setSelectedId(normalized.sections.find((section) => !section.parentId && section.visible)?.id ?? null);
      setInternalParentId(null);
      setStatus('');""",
    "admin load selection",
)

replace_once(
    admin,
    """      setSelectedId(fallback.sections[0]?.id ?? null);
      setStatus(`배치를 불러오지 못했습니다.""",
    """      setSelectedId(fallback.sections.find((section) => !section.parentId && section.visible)?.id ?? null);
      setInternalParentId(null);
      setStatus(`배치를 불러오지 못했습니다.""",
    "admin fallback selection",
)

replace_once(
    admin,
    """                {layout.sections.length}개 항목""",
    """                {canvasSections.length}개 항목""",
    "canvas count",
)

replace_once(
    admin,
    """                {layout.sections.map((section, index) => (""",
    """                {canvasSections.map((section, index) => (""",
    "canvas map",
)

replace_once(
    admin,
    """                       <span className="flex shrink-0 flex-col gap-1">""",
    """                       {layout.sections.some((item) => item.parentId === section.id) ? (
                         <button
                           type="button"
                           onClick={(event) => {
                             event.stopPropagation();
                             setSelectedId(section.id);
                             setInternalParentId(section.id);
                           }}
                           className="shrink-0 rounded-xl border border-primary/30 bg-primary/10 px-2 py-2 text-[9px] font-black text-primary"
                         >
                           내부 수정
                         </button>
                       ) : null}

                       <span className="flex shrink-0 flex-col gap-1">""",
    "internal button in card",
)

replace_once(
    admin,
    """                           disabled={index === layout.sections.length - 1}""",
    """                           disabled={index === canvasSections.length - 1}""",
    "canvas move down",
)

replace_once(
    admin,
    """                {layout.sections.length === 0 ? (""",
    """                {canvasSections.length === 0 ? (""",
    "canvas empty",
)

replace_once(
    admin,
    """                        const next = addCatalogSection(layout, definition.component);
                        setLayout(next);
                        setSelectedId(definition.component);""",
    """                        const next = addCatalogSection(layout, definition.component);
                        setLayout(next);
                        setSelectedId(next.sections.find((section) => section.component === definition.component)?.id ?? null);""",
    "catalog restore selection",
)

replace_once(
    admin,
    """                    <button
                      type="button"
                      onClick={() => updateSection(selected.id, { visible: !selected.visible })}""",
    """                    {layout.sections.some((item) => item.parentId === selected.id) ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPropertyOpen(false);
                          setInternalParentId(selected.id);
                        }}
                        className="flex w-full items-center justify-center gap-2 rounded-2xl border border-primary/40 bg-primary/10 p-3 text-sm font-black text-primary"
                      >
                        <Layers3 className="h-5 w-5" />내부 글씨·버튼·카테고리 수정
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => updateSection(selected.id, { visible: !selected.visible })}""",
    "property internal button",
)

replace_once(
    admin,
    """      {historyOpen ? (""",
    """      {internalParentId ? (
        <UiInternalEditor
          layout={layout}
          parentId={internalParentId}
          onChange={setLayout}
          onClose={() => setInternalParentId(null)}
        />
      ) : null}

      {historyOpen ? (""",
    "render internal editor",
)

# ---------------------------------------------------------------------------
# signal-scan.tsx: stable editable DOM slots
# ---------------------------------------------------------------------------
signal = ROOT / "stock-analyzer/src/pages/signal-scan.tsx"

replace_once(
    signal,
    '<header className="relative flex min-h-[68px] w-full items-center justify-center px-14 text-center">',
    '<header data-ui-edit="signal-scan.header" className="relative flex min-h-[68px] w-full items-center justify-center px-14 text-center">',
    "signal header slot",
)
replace_once(
    signal,
    """            aria-label="뒤로"
            className="absolute left-0""",
    """            aria-label="뒤로"
            data-ui-edit="signal-scan.header.back"
            className="absolute left-0""",
    "signal back slot",
)
replace_once(
    signal,
    '<h1 className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">신호검색</h1>',
    '<h1 data-ui-edit="signal-scan.header.title" className="whitespace-nowrap text-center text-lg font-extrabold leading-tight">신호검색</h1>',
    "signal title slot",
)
replace_once(
    signal,
    '<p className="mt-1 break-keep text-center text-[11px] font-bold leading-4 text-muted-foreground">',
    '<p data-ui-edit="signal-scan.header.subtitle" className="mt-1 break-keep text-center text-[11px] font-bold leading-4 text-muted-foreground">',
    "signal subtitle slot",
)
replace_once(
    signal,
    """            aria-label="새로고침"
            disabled={futuresLocked}""",
    """            aria-label="새로고침"
            data-ui-edit="signal-scan.header.refresh"
            disabled={futuresLocked}""",
    "signal refresh slot",
)
replace_once(
    signal,
    '<div className="mt-3 grid grid-cols-4 gap-1.5">',
    '<div data-ui-edit="signal-scan.mode-tabs" className="mt-3 grid grid-cols-4 gap-1.5">',
    "signal mode tabs slot",
)
replace_once(
    signal,
    """              type="button"
              onClick={() => {
                setScanStyle(item.key);""",
    """              type="button"
              data-ui-edit={`signal-scan.mode.${item.key}`}
              onClick={() => {
                setScanStyle(item.key);""",
    "signal mode button slots",
)
replace_once(
    signal,
    '<p className="mt-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-center text-[10px] font-bold text-warning">\n            실제 15분봉만 사용 · 거래량/거래대금·단기 추세·지지/저항을 함께 확인',
    '<p data-ui-edit="signal-scan.scalp-note" className="mt-2 rounded-xl border border-warning/30 bg-warning/10 px-3 py-2 text-center text-[10px] font-bold text-warning">\n            실제 15분봉만 사용 · 거래량/거래대금·단기 추세·지지/저항을 함께 확인',
    "signal scalp note slot",
)
replace_once(
    signal,
    '<section className="mt-3 rounded-2xl border border-card-border bg-card p-3">',
    '<section data-ui-edit="signal-scan.filters" className="mt-3 rounded-2xl border border-card-border bg-card p-3">',
    "signal filters slot",
)
replace_once(
    signal,
    '<div className="grid grid-cols-2 gap-2">',
    '<div data-ui-edit="signal-scan.condition-panel" className="grid grid-cols-2 gap-2">',
    "signal condition slot",
)

# ---------------------------------------------------------------------------
# bottom-nav.tsx: stable editable slots
# ---------------------------------------------------------------------------
bottom = ROOT / "stock-analyzer/src/components/bottom-nav.tsx"
replace_once(
    bottom,
    """type NavItem = {
  href: string;
  label: string;""",
    """type NavItem = {
  href: string;
  label: string;
  editId: string;""",
    "nav edit id type",
)

nav_ids = [
    ("href: '/',\n    label: '홈',", "href: '/',\n    label: '홈',\n    editId: 'navigation.nav.home',"),
    ("href: '/search',\n    label: '종목',", "href: '/search',\n    label: '종목',\n    editId: 'navigation.nav.markets',"),
    ("href: '/watchlist',\n    label: '관심',", "href: '/watchlist',\n    label: '관심',\n    editId: 'navigation.nav.watch',"),
    ("href: '/tech',\n    label: '기술',", "href: '/tech',\n    label: '기술',\n    editId: 'navigation.nav.tech',"),
    ("href: '/stock-info',\n    label: '정보',", "href: '/stock-info',\n    label: '정보',\n    editId: 'navigation.nav.info',"),
    ("href: '/more',\n    label: '설정',", "href: '/more',\n    label: '설정',\n    editId: 'navigation.nav.settings',"),
]
for index, (old, new) in enumerate(nav_ids):
    replace_once(bottom, old, new, f"nav id {index}")

replace_once(
    bottom,
    """              aria-label="팝업 닫기"
              className="absolute right-4""",
    """              aria-label="팝업 닫기"
              data-ui-edit={`navigation.popup.${popup}.${step}.close`}
              className="absolute right-4""",
    "popup close slot",
)
replace_once(
    bottom,
    """                aria-label="이전 선택"
                className="absolute left-4""",
    """                aria-label="이전 선택"
                data-ui-edit={`navigation.popup.${popup}.${step}.back`}
                className="absolute left-4""",
    "popup back slot",
)
replace_once(
    bottom,
    '<h2 className="mb-5 px-12 text-center text-lg font-extrabold text-white">',
    '<h2 data-ui-edit={`navigation.popup.${popup}.${step}.title`} className="mb-5 px-12 text-center text-lg font-extrabold text-white">',
    "popup title slot",
)
replace_once(
    bottom,
    '<div className="grid grid-cols-1 gap-3">\n              {allowedPopupItems.map((item) => (',
    '<div data-ui-edit={`navigation.popup.${popup}.${step}.items`} className="grid grid-cols-1 gap-3">\n              {allowedPopupItems.map((item, index) => (',
    "popup items container",
)
replace_once(
    bottom,
    """                  type="button"
                  onClick={() => {
                    if (item.step) {""",
    """                  type="button"
                  data-ui-edit={`navigation.popup.${popup}.${step}.item.${index}`}
                  onClick={() => {
                    if (item.step) {""",
    "popup item slots",
)
replace_once(
    bottom,
    """                key={item.href}
                type="button"
                onClick={() => {""",
    """                key={item.href}
                type="button"
                data-ui-edit={item.editId}
                onClick={() => {""",
    "nav button slots",
)

# ---------------------------------------------------------------------------
# Runtime: page + navigation layouts, nested custom nodes, missing element hide
# ---------------------------------------------------------------------------
runtime = r'''import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'wouter';
import { X } from 'lucide-react';
import { authorizedFetch } from '@/lib/auth-fetch';
import {
  UI_COMPONENT_CATALOG,
  normalizeUiLayout,
  type UiLayout,
  type UiPageKey,
  type UiSection,
} from '@/lib/ui-layout';

function pageFromPath(path: string): UiPageKey | null {
  if (path.startsWith('/admin/ui-builder')) return null;
  if (path.startsWith('/tech/signal-scan')) return 'signal-scan';
  if (path === '/' || path.startsWith('/home')) return 'home';
  if (path.startsWith('/stock-info') || path.startsWith('/stock/')) return 'stock-info';
  if (path.startsWith('/stocks') || path.startsWith('/coins/')) return 'stocks';
  if (path.startsWith('/tech')) return 'tech';
  if (path.startsWith('/portfolio') || path.startsWith('/assets')) return 'portfolio';
  if (path.startsWith('/settings') || path.startsWith('/more')) return 'settings';
  return null;
}

function widthValue(section: UiSection) {
  if (section.width === 'half') return '50%';
  if (section.width === 'third') return '33.333%';
  if (section.width === 'auto') return 'auto';
  return '100%';
}

function minHeightValue(section: UiSection) {
  if (section.height === 'compact') return '48px';
  if (section.height === 'normal') return '80px';
  if (section.height === 'tall') return '140px';
  return '';
}

function marginValue(section: UiSection) {
  if (section.spacing === 'none') return '0px';
  if (section.spacing === 'xs') return '4px';
  if (section.spacing === 'sm') return '8px';
  if (section.spacing === 'lg') return '20px';
  if (section.spacing === 'xl') return '28px';
  return '12px';
}

function fontSizeValue(section: UiSection) {
  if (section.fontSize === 'xs') return '12px';
  if (section.fontSize === 'sm') return '14px';
  if (section.fontSize === 'lg') return '18px';
  if (section.fontSize === 'xl') return '20px';
  if (section.fontSize === '2xl') return '24px';
  return '16px';
}

function fontWeightValue(section: UiSection) {
  if (section.fontWeight === 'normal') return '400';
  if (section.fontWeight === 'medium') return '500';
  if (section.fontWeight === 'bold') return '700';
  return '900';
}

function radiusValue(section: UiSection) {
  if (section.radius === 'none') return '0px';
  if (section.radius === 'sm') return '6px';
  if (section.radius === 'md') return '12px';
  if (section.radius === 'lg') return '16px';
  if (section.radius === 'full') return '9999px';
  return '24px';
}

function applyStyle(element: HTMLElement, section: UiSection) {
  element.dataset.uiLayoutNode = section.id;
  element.style.display = section.visible ? '' : 'none';
  element.style.width = widthValue(section);
  element.style.minHeight = minHeightValue(section);
  element.style.marginTop = marginValue(section);
  element.style.textAlign = section.align;
  element.style.opacity = String(section.opacity / 100);
  element.style.transform = `translate(${section.x}px, ${section.y}px)`;
  element.style.zIndex = String(section.zIndex);
  element.style.position = section.x || section.y || section.zIndex ? 'relative' : '';
  element.style.backgroundColor = section.backgroundColor || '';
  element.style.color = section.textColor || '';
  element.style.borderColor = section.borderColor || '';
  element.style.borderRadius = radiusValue(section);
  element.style.setProperty('--ui-title-font-size', fontSizeValue(section));
  element.style.setProperty('--ui-title-font-weight', fontWeightValue(section));
  element.dataset.uiPopupTitle = section.popupTitle ?? '';
  element.dataset.uiPopupContent = section.popupContent ?? '';
  element.dataset.uiPopupPosition = section.popupPosition ?? 'center';
  element.dataset.uiSourceType = section.sourceType;
  element.dataset.uiSourcePath = section.sourcePath ?? '';
}

function makeCustomNode(section: UiSection, pageKey: UiPageKey) {
  const clickable =
    section.kind === 'button' ||
    section.kind === 'tab' ||
    section.kind === 'item' ||
    section.kind === 'popup';
  const element = document.createElement(clickable ? 'button' : section.kind === 'text' ? 'p' : 'div');
  element.setAttribute('data-custom-ui-node', section.id);
  element.setAttribute('data-custom-ui-page', pageKey);
  if (clickable) element.setAttribute('type', 'button');
  element.textContent = section.title || '새 항목';
  element.style.boxSizing = 'border-box';
  element.style.padding = section.kind === 'text' ? '6px 4px' : '12px 14px';
  element.style.borderStyle = section.kind === 'text' ? 'none' : 'solid';
  element.style.borderWidth = section.kind === 'text' ? '0' : '1px';
  element.style.borderColor = section.borderColor || 'hsl(var(--card-border))';
  element.style.backgroundColor = section.backgroundColor || (section.kind === 'text' ? 'transparent' : 'hsl(var(--card))');
  element.style.color = section.textColor || 'hsl(var(--foreground))';
  element.style.fontSize = fontSizeValue(section);
  element.style.fontWeight = fontWeightValue(section);
  element.style.cursor = clickable ? 'pointer' : 'default';
  element.style.boxShadow = section.kind === 'card' ? '0 8px 24px rgba(0,0,0,.12)' : '';
  applyStyle(element, section);
  return element;
}

function applyLayout(root: HTMLElement, layout: UiLayout) {
  root
    .querySelectorAll(`[data-custom-ui-page="${layout.pageKey}"]`)
    .forEach((node) => node.remove());

  const catalog = UI_COMPONENT_CATALOG[layout.pageKey];
  const byComponent = new Map(layout.sections.map((section) => [section.component, section]));
  const resolved = new Map<string, HTMLElement>();
  const main = root.querySelector<HTMLElement>('main');

  for (const definition of catalog) {
    if (!definition.selector) continue;
    const element = root.querySelector<HTMLElement>(definition.selector);
    if (!element) continue;
    const section = byComponent.get(definition.component);
    if (!section) {
      element.style.display = 'none';
      continue;
    }
    resolved.set(section.id, element);
    applyStyle(element, section);
    if (!section.visible) continue;

    if (definition.replaceText && section.title) {
      element.textContent = section.title;
    } else if (definition.titleSelector && section.title) {
      const title = element.querySelector<HTMLElement>(definition.titleSelector);
      if (title) {
        title.textContent = section.title;
        title.style.fontSize = fontSizeValue(section);
        title.style.fontWeight = fontWeightValue(section);
        title.style.textAlign = section.align;
        title.style.color = section.textColor || '';
      }
    } else if (section.kind === 'button' && section.title) {
      element.setAttribute('aria-label', section.title);
    }
  }

  const customSections = layout.sections
    .filter((section) => section.custom)
    .sort((a, b) => a.order - b.order);

  for (const section of customSections) {
    const parent = section.parentId ? resolved.get(section.parentId) : main;
    if (!parent) continue;
    const element = makeCustomNode(section, layout.pageKey);
    resolved.set(section.id, element);
    parent.appendChild(element);
  }

  if (!main) return;
  const orderedMainChildren: HTMLElement[] = [];
  for (const section of layout.sections.filter((item) => !item.parentId)) {
    const element = resolved.get(section.id);
    if (!element) continue;
    if (element.parentElement === main || element.hasAttribute('data-custom-ui-node')) {
      orderedMainChildren.push(element);
    }
  }

  const desiredOrder = orderedMainChildren.map(
    (element) => element.dataset.uiLayoutNode || element.dataset.customUiNode || '',
  );
  const currentOrder = Array.from(main.children)
    .filter((element): element is HTMLElement => element instanceof HTMLElement)
    .map((element) => element.dataset.uiLayoutNode || element.dataset.customUiNode || '')
    .filter(Boolean);

  if (desiredOrder.join('|') !== currentOrder.join('|')) {
    orderedMainChildren.forEach((element) => main.appendChild(element));
  }
}

async function fetchLayout(pageKey: UiPageKey): Promise<UiLayout | null> {
  try {
    const response = await authorizedFetch(`/api/ui-layouts/${pageKey}/published`);
    if (!response.ok) return null;
    const body = (await response.json()) as { version?: { layout?: unknown } | null };
    return body?.version?.layout ? normalizeUiLayout(body.version.layout, pageKey) : null;
  } catch {
    return null;
  }
}

export default function UiLayoutRuntime() {
  const [location, navigate] = useLocation();
  const pageKey = useMemo(() => pageFromPath(location), [location]);
  const [pageLayout, setPageLayout] = useState<UiLayout | null>(null);
  const [navigationLayout, setNavigationLayout] = useState<UiLayout | null>(null);
  const [popup, setPopup] = useState<{
    title: string;
    content: string;
    position: 'center' | 'bottom' | 'top';
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPageLayout(null);
    void fetchLayout('navigation').then((layout) => {
      if (!cancelled) setNavigationLayout(layout);
    });
    if (pageKey) {
      void fetchLayout(pageKey).then((layout) => {
        if (!cancelled) setPageLayout(layout);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [pageKey]);

  useEffect(() => {
    const layouts = [pageLayout, navigationLayout].filter((item): item is UiLayout => Boolean(item));
    if (!layouts.length) return;
    const root = document.querySelector<HTMLElement>('[data-app-shell]');
    if (!root) return;

    let timer = 0;
    let applying = false;
    const run = () => {
      if (applying) return;
      applying = true;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        layouts.forEach((layout) => applyLayout(root, layout));
        applying = false;
      }, 20);
    };

    run();
    const observer = new MutationObserver(() => run());
    observer.observe(root, { childList: true, subtree: true });

    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
      layouts.forEach((layout) => {
        root
          .querySelectorAll(`[data-custom-ui-page="${layout.pageKey}"]`)
          .forEach((node) => node.remove());
      });
    };
  }, [navigationLayout, pageLayout]);

  useEffect(() => {
    const handleClick = async (event: MouseEvent) => {
      const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-ui-layout-node]');
      if (!target) return;

      const title = target.dataset.uiPopupTitle ?? '';
      const content = target.dataset.uiPopupContent ?? '';
      const position = (target.dataset.uiPopupPosition ?? 'center') as 'center' | 'bottom' | 'top';
      const sourceType = target.dataset.uiSourceType ?? 'none';
      const sourcePath = target.dataset.uiSourcePath ?? '';

      if (title || content) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPopup({ title: title || target.textContent?.trim() || '안내', content, position });
        return;
      }

      if (sourceType === 'route' && sourcePath.startsWith('/')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        navigate(sourcePath);
        return;
      }

      if (sourceType === 'api' && sourcePath.startsWith('/api/')) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setPopup({ title: '조회 중', content: '데이터를 불러오고 있습니다.', position: 'center' });
        try {
          const response = await authorizedFetch(sourcePath);
          const body = await response.json().catch(() => ({}));
          setPopup({
            title: response.ok ? '조회 결과' : '조회 실패',
            content: JSON.stringify(body, null, 2).slice(0, 4000),
            position: 'center',
          });
        } catch {
          setPopup({ title: '조회 실패', content: 'API 데이터를 불러오지 못했습니다.', position: 'center' });
        }
      }
    };

    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [navigate]);

  if (!popup) return null;

  return (
    <div
      className={`fixed inset-0 z-[100] flex bg-black/65 p-4 ${
        popup.position === 'bottom'
          ? 'items-end'
          : popup.position === 'top'
            ? 'items-start pt-20'
            : 'items-center'
      }`}
      onClick={() => setPopup(null)}
    >
      <section
        className="mx-auto max-h-[75vh] w-full max-w-md overflow-y-auto rounded-3xl border border-card-border bg-background p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-lg font-black">{popup.title}</h2>
          <button
            type="button"
            onClick={() => setPopup(null)}
            className="rounded-xl border border-card-border p-2"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <pre className="mt-4 whitespace-pre-wrap break-words font-sans text-sm font-bold leading-6 text-muted-foreground">
          {popup.content || '내용이 없습니다.'}
        </pre>
      </section>
    </div>
  );
}
'''
write(ROOT / "stock-analyzer/src/components/ui-layout-runtime.tsx", runtime)

# ---------------------------------------------------------------------------
# API allowlists and nested parent validation
# ---------------------------------------------------------------------------
admin_api = ROOT / "api-server/src/routes/admin-ui-layouts.ts"
replace_once(
    admin_api,
    """  'signal-scan': new Set([
    'signal-scan.header',
    'signal-scan.filters',
    'signal-scan.summary',
    'signal-scan.results',
  ]),""",
    """  'signal-scan': new Set([
    'signal-scan.header',
    'signal-scan.header.back',
    'signal-scan.header.title',
    'signal-scan.header.subtitle',
    'signal-scan.header.refresh',
    'signal-scan.filters',
    'signal-scan.mode-tabs',
    'signal-scan.mode.scalp',
    'signal-scan.mode.swing',
    'signal-scan.mode.long',
    'signal-scan.mode.custom',
    'signal-scan.scalp-note',
    'signal-scan.condition-panel',
    'signal-scan.summary',
    'signal-scan.results',
  ]),""",
    "api signal components",
)

navigation_api = """  navigation: new Set([
    'navigation.nav.home',
    'navigation.nav.markets',
    'navigation.popup.markets.main.close',
    'navigation.popup.markets.main.title',
    'navigation.popup.markets.main.items',
    'navigation.popup.markets.main.item.0',
    'navigation.popup.markets.main.item.1',
    'navigation.popup.markets.stocks.close',
    'navigation.popup.markets.stocks.back',
    'navigation.popup.markets.stocks.title',
    'navigation.popup.markets.stocks.items',
    'navigation.popup.markets.stocks.item.0',
    'navigation.popup.markets.stocks.item.1',
    'navigation.popup.markets.coins.close',
    'navigation.popup.markets.coins.back',
    'navigation.popup.markets.coins.title',
    'navigation.popup.markets.coins.items',
    'navigation.popup.markets.coins.item.0',
    'navigation.popup.markets.coins.item.1',
    'navigation.nav.watch',
    'navigation.nav.tech',
    'navigation.nav.info',
    'navigation.nav.settings',
  ]),
"""
replace_once(admin_api, """  settings: new Set([""", navigation_api + """  settings: new Set([""", "api navigation components")

routes = [
    '/home', '/search', '/stocks', '/stocks/kr', '/stocks/us', '/coins/spot', '/coins/futures',
    '/watchlist',
    '/watchlist/assets?view=watchlist&asset=stockKR', '/watchlist/assets?view=watchlist&asset=stockUS',
    '/watchlist/assets?view=watchlist&asset=coinSpot', '/watchlist/assets?view=watchlist&asset=coinFutures',
    '/watchlist/assets?view=alerts&asset=stockKR', '/watchlist/assets?view=alerts&asset=stockUS',
    '/watchlist/assets?view=alerts&asset=coinSpot', '/watchlist/assets?view=alerts&asset=coinFutures',
    '/tech', '/tech/signal-scan',
    '/tech/chart-relay?asset=stockKR&tab=live&focused=1',
    '/tech/chart-relay?asset=stockUS&tab=live&focused=1',
    '/tech/chart-relay?asset=coinSpot&tab=live&focused=1',
    '/tech/chart-relay?asset=coinFutures&tab=live&focused=1',
    '/tech/auto-trade', '/portfolio',
    '/portfolio/summary?asset=all&source=info', '/portfolio/summary?asset=all&source=portfolio',
    '/stock-info', '/stock-info?asset=stock&market=KR&focused=1',
    '/stock-info?asset=stock&market=US&focused=1',
    '/stock-info?asset=coin&coinMarket=spot&focused=1',
    '/stock-info?asset=coin&coinMarket=futures&focused=1',
    '/learn', '/analysis/KR', '/analysis/US', '/settings', '/more', '/account',
]
route_set = "const ALLOWED_ROUTES = new Set([\n" + "\n".join(f"  '{route}'," for route in routes) + "\n]);"
start = admin_api.read_text(encoding="utf-8")
old_start = start.index("const ALLOWED_ROUTES = new Set([")
old_end = start.index("]);", old_start) + 3
admin_api.write_text(start[:old_start] + route_set + start[old_end:], encoding="utf-8")

replace_once(
    admin_api,
    """  sections.sort((a, b) => Number(a.order) - Number(b.order));""",
    """  const sectionIds = new Set(sections.map((section) => String(section.id)));
  for (const section of sections) {
    const parentId = section.parentId ? String(section.parentId) : '';
    if (parentId && (!sectionIds.has(parentId) || parentId === section.id)) return null;
  }

  sections.sort((a, b) => Number(a.order) - Number(b.order));""",
    "api parent validation",
)

public_api = ROOT / "api-server/src/routes/ui-layouts.ts"
replace_once(
    public_api,
    """  'settings',
]);""",
    """  'settings',
  'navigation',
]);""",
    "public navigation page",
)

print("✅ UI 편집기 3차 내부 편집 패치 적용 완료")
print("변경 파일:")
for relative in [
    "stock-analyzer/src/lib/ui-layout.ts",
    "stock-analyzer/src/components/ui-internal-editor.tsx",
    "stock-analyzer/src/components/ui-layout-runtime.tsx",
    "stock-analyzer/src/components/bottom-nav.tsx",
    "stock-analyzer/src/pages/signal-scan.tsx",
    "stock-analyzer/src/pages/admin-ui-builder.tsx",
    "api-server/src/routes/admin-ui-layouts.ts",
    "api-server/src/routes/ui-layouts.ts",
]:
    print(f"- {relative}")
