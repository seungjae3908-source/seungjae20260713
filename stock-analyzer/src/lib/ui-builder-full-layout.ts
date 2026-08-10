import {
  UI_BUILDER_BLOCK_TYPES,
  UI_BUILDER_SCHEMA_VERSION,
  UI_BUILDER_STABLE_SHA,
  UI_BUILDER_STABLE_TREE,
  type UiBuilderBlockType,
  type UiBuilderCardStyle,
  type UiBuilderDensity,
  type UiBuilderDeviceClass,
  type UiBuilderVisibilityMode,
} from './ui-builder-layout';

export { UI_BUILDER_STABLE_SHA, UI_BUILDER_STABLE_TREE, UI_BUILDER_SCHEMA_VERSION };
export type { UiBuilderDeviceClass };

export const UI_BUILDER_PAGE_IDS = [
  'HOME', 'ASSET_SEARCH', 'STOCK_MARKET', 'CRYPTO_MARKET', 'ASSET_DETAIL', 'SIGNAL_SCANNER', 'AI_CHART',
  'POSITION', 'PORTFOLIO', 'AUTO_TRADING', 'AI_CHAT', 'NEWS_INFORMATION', 'SETTINGS', 'ACCOUNT_CONNECTION',
] as const;
export type UiBuilderPageId = (typeof UI_BUILDER_PAGE_IDS)[number];
export type UiBuilderFullLayoutStatus = 'draft' | 'preview' | 'active';

export type UiBuilderFullBlock = {
  id: string;
  type: UiBuilderBlockType;
  props: {
    title: string;
    subtitle?: string;
    density: UiBuilderDensity;
    collapsedByDefault: boolean;
    expandable: boolean;
    cardStyle: UiBuilderCardStyle;
  };
  layout: { order: number; colSpan: number; minHeight: number; sticky: boolean; bottomFixed: boolean };
  visibility: { mode: UiBuilderVisibilityMode; hidden: boolean };
  actionId?: string;
};

export type UiBuilderFullLayoutDocument = {
  schemaVersion: typeof UI_BUILDER_SCHEMA_VERSION;
  layoutId: string;
  pageId: UiBuilderPageId;
  deviceClass: UiBuilderDeviceClass;
  version: number;
  status: 'draft' | 'published';
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  blocks: UiBuilderFullBlock[];
};

export type UiBuilderFullValidationIssue = { code: string; message: string; blockId?: string };
export type UiBuilderFullValidationResult = { valid: boolean; issues: UiBuilderFullValidationIssue[] };

const PAGE_SET = new Set<string>(UI_BUILDER_PAGE_IDS);
const BLOCK_SET = new Set<string>(UI_BUILDER_BLOCK_TYPES);
const DENSITY_SET = new Set(['compact', 'normal', 'detailed']);
const CARD_STYLE_SET = new Set(['flat', 'outlined', 'elevated']);
const VISIBILITY_SET = new Set(['both', 'mobile', 'desktop', 'hidden']);
const BLOCK_KEYS = new Set(['id', 'type', 'props', 'layout', 'visibility', 'actionId']);
const PROP_KEYS = new Set(['title', 'subtitle', 'density', 'collapsedByDefault', 'expandable', 'cardStyle']);
const LAYOUT_KEYS = new Set(['order', 'colSpan', 'minHeight', 'sticky', 'bottomFixed']);
const VISIBILITY_KEYS = new Set(['mode', 'hidden']);
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const URL_OR_API_VALUE = /(?:https?:\/\/|\/api\/|wss?:\/\/|javascript:)/i;
const PHASE1_SCANNER_KEY = (device: UiBuilderDeviceClass) => `stock-ui-builder:published-layout:SIGNAL_SCANNER:${device}`;

const SAFE_ACTION_IDS: Partial<Record<UiBuilderBlockType, string>> = {
  TradeReviewButton: 'TRADE_REVIEW', BuyReviewButton: 'TRADE_REVIEW_BUY', SellReviewButton: 'TRADE_REVIEW_SELL',
  LongReviewButton: 'TRADE_REVIEW_LONG', ShortReviewButton: 'TRADE_REVIEW_SHORT', AutomationControl: 'AUTOMATION_REVIEW_CONTROL',
};

const REQUIRED_BLOCKS: Record<UiBuilderPageId, UiBuilderBlockType[]> = {
  HOME: ['PageHeader'], ASSET_SEARCH: ['PageHeader'], STOCK_MARKET: ['PageHeader'], CRYPTO_MARKET: ['PageHeader'],
  ASSET_DETAIL: ['PageHeader'], SIGNAL_SCANNER: ['PageHeader'], AI_CHART: ['PageHeader'], POSITION: ['PageHeader'],
  PORTFOLIO: ['PageHeader'], AUTO_TRADING: ['PageHeader', 'EmergencyStop'], AI_CHAT: ['PageHeader'],
  NEWS_INFORMATION: ['PageHeader'], SETTINGS: ['PageHeader'], ACCOUNT_CONNECTION: ['PageHeader'],
};

const TEMPLATE_BLOCKS: Record<UiBuilderPageId, { mobile: UiBuilderBlockType[]; desktop: UiBuilderBlockType[] }> = {
  HOME: { mobile: ['PageHeader','UnifiedSearch','MarketSummary','TopSignals','Watchlist','PortfolioSummary'], desktop: ['PageHeader','UnifiedSearch','MarketSummary','TopSignals','Watchlist','PortfolioSummary'] },
  ASSET_SEARCH: { mobile: ['PageHeader','UnifiedSearch','AssetSearchResults','Watchlist'], desktop: ['PageHeader','UnifiedSearch','AssetSearchResults','Watchlist','MarketRankings'] },
  STOCK_MARKET: { mobile: ['PageHeader','MarketSummary','MarketRankings','TopSignals','NewsSummary','ThemeSummary'], desktop: ['PageHeader','MarketSummary','MarketRankings','TopSignals','NewsSummary','ThemeSummary'] },
  CRYPTO_MARKET: { mobile: ['PageHeader','MarketSummary','MarketRankings','TopSignals','AiOpinion','TechnicalSummary'], desktop: ['PageHeader','MarketSummary','MarketRankings','TopSignals','AiOpinion','TechnicalSummary'] },
  ASSET_DETAIL: { mobile: ['PageHeader','PositionSummary','AiOpinion','AiChart','PricePlan','AiReason','NewsSummary','DisclosureSummary','FinancialSummary','TechnicalSummary','TradeReviewButton'], desktop: ['PageHeader','PositionSummary','AiOpinion','AiChart','PricePlan','AiReason','NewsSummary','DisclosureSummary','FinancialSummary','TechnicalSummary','TradeReviewButton'] },
  SIGNAL_SCANNER: { mobile: ['PageHeader','MarketSelector','StrategySelector','TimeframeSelector','DirectionSelector','SignalSummary','SignalList','PositionSummary','TradeReviewButton'], desktop: ['PageHeader','MarketSelector','StrategySelector','TimeframeSelector','DirectionSelector','SignalList','AiChart','AiOpinion','PositionSummary','PricePlan','TradeReviewButton','SignalSummary'] },
  AI_CHART: { mobile: ['PageHeader','UnifiedSearch','AiChart','AiOpinion','AiReason','PricePlan','PositionSummary','TechnicalSummary','TradeReviewButton'], desktop: ['PageHeader','UnifiedSearch','AiChart','AiOpinion','AiReason','PricePlan','PositionSummary','TechnicalSummary','TradeReviewButton'] },
  POSITION: { mobile: ['PageHeader','PositionSummary','PositionDetail','PositionOpinion','RiskSummary','AiChart','TradeReviewButton'], desktop: ['PageHeader','PositionSummary','PositionDetail','PositionOpinion','RiskSummary','AiChart','TradeReviewButton'] },
  PORTFOLIO: { mobile: ['PageHeader','PortfolioSummary','PnLSummary','RiskSummary','PortfolioPositions','AiOpinion'], desktop: ['PageHeader','PortfolioSummary','PnLSummary','RiskSummary','PortfolioPositions','AiOpinion'] },
  AUTO_TRADING: { mobile: ['PageHeader','AutoTradingStatus','AutoTradingStrategy','AutoTradingRisk','AutomationControl','EmergencyStop'], desktop: ['PageHeader','AutoTradingStatus','AutoTradingStrategy','AutoTradingRisk','AutomationControl','EmergencyStop'] },
  AI_CHAT: { mobile: ['PageHeader','AiChat','AiOpinion','AiReason','PositionSummary'], desktop: ['PageHeader','AiChat','AiOpinion','AiReason','PositionSummary'] },
  NEWS_INFORMATION: { mobile: ['PageHeader','NewsSummary','DisclosureSummary','MarketSummary','ThemeSummary'], desktop: ['PageHeader','NewsSummary','DisclosureSummary','MarketSummary','ThemeSummary'] },
  SETTINGS: { mobile: ['PageHeader','SettingsNavigation','SettingCategory','SettingCategory','SettingCategory','SettingCategory'], desktop: ['PageHeader','SettingsNavigation','SettingCategory','SettingCategory','SettingCategory','SettingCategory'] },
  ACCOUNT_CONNECTION: { mobile: ['PageHeader','AccountConnectionStatus','ProviderStatus','SystemStatus','AdvancedInfo'], desktop: ['PageHeader','AccountConnectionStatus','ProviderStatus','SystemStatus','AdvancedInfo'] },
};

export const UI_BUILDER_PAGE_RUNTIME_OWNER: Record<UiBuilderPageId, string> = {
  HOME: 'HomePage', ASSET_SEARCH: 'UnifiedAssetSearchPage + UnifiedAssetSearch', STOCK_MARKET: 'MarketInformationPage',
  CRYPTO_MARKET: 'MarketInformationPage', ASSET_DETAIL: 'StockInfoPage + AiChartPage',
  SIGNAL_SCANNER: 'TechnicalWorkspacePage + SignalScannerPage + AiChartPage', AI_CHART: 'AiChartPage + UnifiedAnalysisChart',
  POSITION: 'PortfolioPage + AiChartPage', PORTFOLIO: 'PortfolioPage',
  AUTO_TRADING: 'AutoTradingPage + TradeAutomationSettings + TradingRiskPreviewPanel', AI_CHAT: 'AiChatPage',
  NEWS_INFORMATION: 'StockInfoPage tabs + ThemesPage', SETTINGS: 'MorePage', ACCOUNT_CONNECTION: 'AccountPage + BrokerageAccountConnections',
};

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function visible(block: UiBuilderFullBlock, device: UiBuilderDeviceClass) { return !block.visibility.hidden && block.visibility.mode !== 'hidden' && (block.visibility.mode === 'both' || block.visibility.mode === device); }
function rejectUnknownKeys(record: Record<string, unknown>, allowed: Set<string>, issues: UiBuilderFullValidationIssue[], code: string, blockId?: string) { for (const key of Object.keys(record)) if (!allowed.has(key)) issues.push({ code, message: `허용되지 않은 속성: ${key}`, blockId }); }
function validateText(value: unknown, label: string, issues: UiBuilderFullValidationIssue[], blockId?: string) {
  if (typeof value !== 'string') { issues.push({ code: 'INVALID_TEXT_PROP', message: `${label}은 문자열이어야 합니다.`, blockId }); return; }
  if (SECRET_VALUE.test(value)) issues.push({ code: 'SECRET_TOKEN_REJECTED', message: `${label}에 secret/token 값을 넣을 수 없습니다.`, blockId });
  if (URL_OR_API_VALUE.test(value)) issues.push({ code: 'URL_API_BINDING_REJECTED', message: `${label}에 URL/API/스크립트 경로를 넣을 수 없습니다.`, blockId });
}

export function validateUiBuilderFullLayout(candidate: unknown, expectedPage: UiBuilderPageId, expectedDevice: UiBuilderDeviceClass): UiBuilderFullValidationResult {
  const issues: UiBuilderFullValidationIssue[] = [];
  if (!isRecord(candidate)) return { valid: false, issues: [{ code: 'INVALID_LAYOUT', message: 'Layout은 object여야 합니다.' }] };
  const doc = candidate as Record<string, unknown>;
  if (doc.schemaVersion !== UI_BUILDER_SCHEMA_VERSION) issues.push({ code: 'UNSUPPORTED_SCHEMA_VERSION', message: `지원하지 않는 schemaVersion: ${String(doc.schemaVersion)}` });
  if (typeof doc.pageId !== 'string' || !PAGE_SET.has(doc.pageId)) issues.push({ code: 'UNSUPPORTED_PAGE', message: `지원하지 않는 pageId: ${String(doc.pageId)}` });
  else if (doc.pageId !== expectedPage) issues.push({ code: 'PAGE_ID_MISMATCH', message: `${expectedPage} Layout이 아닙니다.` });
  if (doc.deviceClass !== expectedDevice) issues.push({ code: 'DEVICE_CLASS_MISMATCH', message: `${expectedDevice} Layout이 아닙니다.` });
  if (!Array.isArray(doc.blocks)) return { valid: false, issues: [...issues, { code: 'INVALID_BLOCKS', message: 'blocks 배열이 필요합니다.' }] };

  const ids = new Set<string>(); const orders = new Set<number>(); const visibleTypes = new Set<UiBuilderBlockType>();
  for (const raw of doc.blocks) {
    if (!isRecord(raw)) { issues.push({ code: 'INVALID_BLOCK', message: 'block은 object여야 합니다.' }); continue; }
    const id = typeof raw.id === 'string' ? raw.id : undefined;
    rejectUnknownKeys(raw, BLOCK_KEYS, issues, 'FORBIDDEN_BLOCK_PROP', id);
    if (!id?.trim()) issues.push({ code: 'INVALID_BLOCK_ID', message: 'block id가 필요합니다.' });
    else if (ids.has(id)) issues.push({ code: 'DUPLICATE_BLOCK_ID', message: `중복 block id: ${id}`, blockId: id }); else ids.add(id);
    if (typeof raw.type !== 'string' || !BLOCK_SET.has(raw.type)) { issues.push({ code: 'UNKNOWN_COMPONENT', message: `Registry에 없는 component: ${String(raw.type)}`, blockId: id }); continue; }
    const type = raw.type as UiBuilderBlockType;
    if (!isRecord(raw.props)) issues.push({ code: 'INVALID_PROPS', message: 'props object가 필요합니다.', blockId: id });
    else {
      rejectUnknownKeys(raw.props, PROP_KEYS, issues, 'FORBIDDEN_RUNTIME_PROP', id); validateText(raw.props.title, 'title', issues, id);
      if (raw.props.subtitle !== undefined) validateText(raw.props.subtitle, 'subtitle', issues, id);
      if (!DENSITY_SET.has(String(raw.props.density))) issues.push({ code: 'INVALID_DENSITY', message: 'density가 올바르지 않습니다.', blockId: id });
      if (!CARD_STYLE_SET.has(String(raw.props.cardStyle))) issues.push({ code: 'INVALID_CARD_STYLE', message: 'cardStyle가 올바르지 않습니다.', blockId: id });
      if (typeof raw.props.collapsedByDefault !== 'boolean' || typeof raw.props.expandable !== 'boolean') issues.push({ code: 'INVALID_PROP_FLAGS', message: 'collapse/expand 속성은 boolean이어야 합니다.', blockId: id });
    }
    if (!isRecord(raw.layout)) issues.push({ code: 'INVALID_BLOCK_LAYOUT', message: 'layout object가 필요합니다.', blockId: id });
    else {
      rejectUnknownKeys(raw.layout, LAYOUT_KEYS, issues, 'FORBIDDEN_LAYOUT_PROP', id);
      const order = Number(raw.layout.order); const colSpan = Number(raw.layout.colSpan);
      if (!Number.isInteger(order) || order < 0) issues.push({ code: 'INVALID_ORDER', message: 'order는 0 이상의 정수여야 합니다.', blockId: id });
      else if (orders.has(order)) issues.push({ code: 'DUPLICATE_ORDER', message: `중복 order: ${order}`, blockId: id }); else orders.add(order);
      if (!Number.isInteger(colSpan) || colSpan < 1 || colSpan > 12) issues.push({ code: 'INVALID_COLUMN_SPAN', message: 'colSpan은 1~12 정수여야 합니다.', blockId: id });
      if (!Number.isFinite(Number(raw.layout.minHeight)) || Number(raw.layout.minHeight) < 0) issues.push({ code: 'INVALID_MIN_HEIGHT', message: 'minHeight가 올바르지 않습니다.', blockId: id });
      if (typeof raw.layout.sticky !== 'boolean' || typeof raw.layout.bottomFixed !== 'boolean') issues.push({ code: 'INVALID_LAYOUT_FLAGS', message: 'sticky/bottomFixed는 boolean이어야 합니다.', blockId: id });
    }
    if (!isRecord(raw.visibility)) issues.push({ code: 'INVALID_VISIBILITY', message: 'visibility object가 필요합니다.', blockId: id });
    else {
      rejectUnknownKeys(raw.visibility, VISIBILITY_KEYS, issues, 'FORBIDDEN_VISIBILITY_PROP', id);
      if (!VISIBILITY_SET.has(String(raw.visibility.mode))) issues.push({ code: 'INVALID_VISIBILITY_MODE', message: 'visibility.mode가 올바르지 않습니다.', blockId: id });
      if (typeof raw.visibility.hidden !== 'boolean') issues.push({ code: 'INVALID_VISIBILITY_HIDDEN', message: 'visibility.hidden은 boolean이어야 합니다.', blockId: id });
    }
    const expectedAction = SAFE_ACTION_IDS[type];
    if (expectedAction && raw.actionId !== expectedAction) issues.push({ code: 'SAFE_ACTION_MUTATION_REJECTED', message: `${type} actionId는 ${expectedAction}로 고정됩니다.`, blockId: id });
    if (!expectedAction && raw.actionId !== undefined) issues.push({ code: 'ARBITRARY_ACTION_REJECTED', message: `${type}에는 actionId를 지정할 수 없습니다.`, blockId: id });
    if (isRecord(raw.visibility) && visible(raw as unknown as UiBuilderFullBlock, expectedDevice)) visibleTypes.add(type);
  }
  for (const required of REQUIRED_BLOCKS[expectedPage]) if (!visibleTypes.has(required)) issues.push({ code: 'REQUIRED_BLOCK_MISSING', message: `${expectedPage}에서 ${required}는 숨기거나 삭제할 수 없습니다.` });
  return { valid: issues.length === 0, issues };
}

export function uiBuilderLayoutStorageKey(status: UiBuilderFullLayoutStatus, pageId: UiBuilderPageId, device: UiBuilderDeviceClass) { return `stock-ui-builder:${status}-layout:${pageId}:${device}`; }
export function parseAndValidateUiBuilderLayout(raw: string, pageId: UiBuilderPageId, device: UiBuilderDeviceClass): { valid: boolean; layout: UiBuilderFullLayoutDocument | null; issues: UiBuilderFullValidationIssue[] } {
  let candidate: unknown;
  try { candidate = JSON.parse(raw); }
  catch { return { valid: false, layout: null, issues: [{ code: 'INVALID_JSON', message: 'Layout JSON을 파싱할 수 없습니다.' }] }; }
  const validation = validateUiBuilderFullLayout(candidate, pageId, device);
  return validation.valid ? { valid: true, layout: candidate as UiBuilderFullLayoutDocument, issues: [] } : { valid: false, layout: null, issues: validation.issues };
}
export function readUiBuilderStoredLayout(status: UiBuilderFullLayoutStatus, pageId: UiBuilderPageId, device: UiBuilderDeviceClass): string | null { return typeof window === 'undefined' ? null : window.localStorage.getItem(uiBuilderLayoutStorageKey(status, pageId, device)); }
export function writeUiBuilderStoredLayout(status: UiBuilderFullLayoutStatus, layout: UiBuilderFullLayoutDocument): void {
  if (typeof window === 'undefined') return; const validation = validateUiBuilderFullLayout(layout, layout.pageId, layout.deviceClass);
  if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('\n'));
  window.localStorage.setItem(uiBuilderLayoutStorageKey(status, layout.pageId, layout.deviceClass), JSON.stringify(layout));
  window.dispatchEvent(new CustomEvent('stock-ui-builder-layout-updated', { detail: { status, pageId: layout.pageId, deviceClass: layout.deviceClass } }));
}
export function clearUiBuilderStoredLayout(status: UiBuilderFullLayoutStatus, pageId: UiBuilderPageId, device: UiBuilderDeviceClass): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(uiBuilderLayoutStorageKey(status, pageId, device));
  if (status === 'active' && pageId === 'SIGNAL_SCANNER') window.localStorage.removeItem(PHASE1_SCANNER_KEY(device));
  window.dispatchEvent(new CustomEvent('stock-ui-builder-layout-updated', { detail: { status, pageId, deviceClass: device } }));
}
export function activateUiBuilderLayout(layout: UiBuilderFullLayoutDocument): void {
  const validation = validateUiBuilderFullLayout(layout, layout.pageId, layout.deviceClass);
  if (!validation.valid) throw new Error(validation.issues.map((issue) => issue.message).join('\n'));
  writeUiBuilderStoredLayout('active', layout);
  if (typeof window !== 'undefined' && layout.pageId === 'SIGNAL_SCANNER') {
    window.localStorage.setItem(PHASE1_SCANNER_KEY(layout.deviceClass), JSON.stringify(layout));
  }
}
export function loadActiveUiBuilderLayout(pageId: UiBuilderPageId, device: UiBuilderDeviceClass): { source: 'active' | 'fallback'; layout: UiBuilderFullLayoutDocument; issues: UiBuilderFullValidationIssue[] } {
  const fallback = makeFrozenUiBuilderTemplate(pageId, device); const raw = readUiBuilderStoredLayout('active', pageId, device);
  if (!raw) return { source: 'fallback', layout: fallback, issues: [] };
  const parsed = parseAndValidateUiBuilderLayout(raw, pageId, device);
  return parsed.valid && parsed.layout ? { source: 'active', layout: structuredClone(parsed.layout), issues: [] } : { source: 'fallback', layout: fallback, issues: parsed.issues };
}
function actionFor(type: UiBuilderBlockType) { return SAFE_ACTION_IDS[type]; }
export function makeFrozenUiBuilderTemplate(pageId: UiBuilderPageId, device: UiBuilderDeviceClass): UiBuilderFullLayoutDocument {
  const now = '2026-08-10T00:00:00.000Z'; const specs = TEMPLATE_BLOCKS[pageId][device];
  return { schemaVersion: UI_BUILDER_SCHEMA_VERSION, layoutId: `builder-frozen-${pageId.toLowerCase()}-${device}`, pageId, deviceClass: device, version: 1, status: 'published', createdAt: now, updatedAt: now, publishedAt: now,
    blocks: specs.map((type, order) => ({ id: `${pageId.toLowerCase()}-${type.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, '')}-${order + 1}`, type,
      props: { title: type, density: ['AiChart','SignalList','PortfolioPositions'].includes(type) ? 'detailed' : 'compact', collapsedByDefault: false, expandable: false, cardStyle: 'outlined' },
      layout: { order, colSpan: device === 'mobile' ? 12 : type === 'PageHeader' ? 12 : 6, minHeight: type === 'AiChart' ? 420 : 88, sticky: false, bottomFixed: false }, visibility: { mode: 'both', hidden: false }, ...(actionFor(type) ? { actionId: actionFor(type) } : {}) })) };
}
export function uiBuilderTemplateCoverage() { return UI_BUILDER_PAGE_IDS.map((pageId) => ({ pageId, owner: UI_BUILDER_PAGE_RUNTIME_OWNER[pageId], mobileBlocks: TEMPLATE_BLOCKS[pageId].mobile.length, desktopBlocks: TEMPLATE_BLOCKS[pageId].desktop.length })); }
