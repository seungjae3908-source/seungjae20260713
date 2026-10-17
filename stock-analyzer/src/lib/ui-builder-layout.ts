export const UI_BUILDER_STABLE_SHA = 'c98915da80c57a02c7e037522f6ae7dabd07664d' as const;
export const UI_BUILDER_STABLE_TREE = '43cd3798164f709786281b7f85acd68b0c9d9095' as const;
export const UI_BUILDER_SCHEMA_VERSION = 1 as const;

export type UiBuilderDeviceClass = 'mobile' | 'desktop';
export type UiBuilderDensity = 'compact' | 'normal' | 'detailed';
export type UiBuilderCardStyle = 'flat' | 'outlined' | 'elevated';
export type UiBuilderVisibilityMode = 'both' | 'mobile' | 'desktop' | 'hidden';
export type UiBuilderLayoutStatus = 'draft' | 'published';

export const UI_BUILDER_BLOCK_TYPES = [
  'PageHeader',
  'UnifiedSearch',
  'MarketSummary',
  'TopSignals',
  'Watchlist',
  'PortfolioSummary',
  'MarketSelector',
  'StrategySelector',
  'TimeframeSelector',
  'DirectionSelector',
  'SignalSummary',
  'SignalList',
  'AssetSearchResults',
  'MarketRankings',
  'ThemeSummary',
  'AiChart',
  'AiOpinion',
  'AiReason',
  'AiChat',
  'PositionSummary',
  'PositionDetail',
  'PositionOpinion',
  'PricePlan',
  'TradeReviewButton',
  'BuyReviewButton',
  'SellReviewButton',
  'LongReviewButton',
  'ShortReviewButton',
  'PortfolioPositions',
  'PnLSummary',
  'RiskSummary',
  'NewsSummary',
  'DisclosureSummary',
  'FinancialSummary',
  'TechnicalSummary',
  'AutoTradingStatus',
  'AutoTradingStrategy',
  'AutoTradingRisk',
  'AutomationControl',
  'EmergencyStop',
  'SettingsNavigation',
  'SettingCategory',
  'ProviderStatus',
  'AccountConnectionStatus',
  'SystemStatus',
  'AdvancedInfo',
] as const;

export type UiBuilderBlockType = (typeof UI_BUILDER_BLOCK_TYPES)[number];

export type UiBuilderBlockProps = {
  title: string;
  subtitle?: string;
  density: UiBuilderDensity;
  collapsedByDefault: boolean;
  expandable: boolean;
  cardStyle: UiBuilderCardStyle;
};

export type UiBuilderBlockLayout = {
  order: number;
  colSpan: number;
  minHeight: number;
  sticky: boolean;
  bottomFixed: boolean;
};

export type UiBuilderBlockVisibility = {
  mode: UiBuilderVisibilityMode;
  hidden: boolean;
};

export type UiBuilderLayoutBlock = {
  id: string;
  type: UiBuilderBlockType;
  props: UiBuilderBlockProps;
  layout: UiBuilderBlockLayout;
  visibility: UiBuilderBlockVisibility;
  actionId?: string;
};

export type UiBuilderLayoutDocument = {
  schemaVersion: typeof UI_BUILDER_SCHEMA_VERSION;
  layoutId: string;
  pageId: 'SIGNAL_SCANNER';
  deviceClass: UiBuilderDeviceClass;
  version: number;
  status: UiBuilderLayoutStatus;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  blocks: UiBuilderLayoutBlock[];
};

export type RegistryMappingClassification =
  | 'EXISTING_EXACT'
  | 'EXISTING_ADAPTER_REQUIRED'
  | 'EXISTING_COMPOSITE_REQUIRED'
  | 'MOCK_ONLY'
  | 'MISSING'
  | 'FORBIDDEN_RUNTIME_BINDING';

export type ScannerRuntimeSurface = 'scanner' | 'chart' | 'position' | 'trade-review' | null;

export type RegistryMapping = {
  classification: RegistryMappingClassification;
  target: string;
  scannerSurface: ScannerRuntimeSurface;
  note: string;
};

const composite = (target: string, scannerSurface: ScannerRuntimeSurface = null, note = 'Reuse existing Stock App surface.') =>
  ({ classification: 'EXISTING_COMPOSITE_REQUIRED', target, scannerSurface, note }) satisfies RegistryMapping;
const exact = (target: string, scannerSurface: ScannerRuntimeSurface = null, note = 'Existing Stock App component is an exact functional surface.') =>
  ({ classification: 'EXISTING_EXACT', target, scannerSurface, note }) satisfies RegistryMapping;
const adapter = (target: string, scannerSurface: ScannerRuntimeSurface = null, note = 'Presentation-only adapter required; runtime endpoint/configuration is fixed by Stock App.') =>
  ({ classification: 'EXISTING_ADAPTER_REQUIRED', target, scannerSurface, note }) satisfies RegistryMapping;

export const UI_BUILDER_REGISTRY_MAPPING: Record<UiBuilderBlockType, RegistryMapping> = {
  PageHeader: composite('SignalScannerPage / page headers', 'scanner'),
  UnifiedSearch: exact('UnifiedAssetSearch'),
  MarketSummary: composite('MarketInformationPage / MarketOverviewPage'),
  TopSignals: composite('SignalScannerPage'),
  Watchlist: composite('WatchlistPage'),
  PortfolioSummary: composite('PortfolioPage'),
  MarketSelector: composite('SignalScannerPage: 검색 시장', 'scanner'),
  StrategySelector: composite('SignalScannerPage: 검색 전략', 'scanner'),
  TimeframeSelector: composite('SignalScannerPage: 시간봉', 'scanner'),
  DirectionSelector: composite(
    'SignalScannerPage: market-derived direction semantics',
    'scanner',
    'Direction is derived from the selected market and existing signal direction; no second scoring/filter engine is introduced.',
  ),
  SignalSummary: composite('SignalScannerPage: response/data-state summary', 'scanner'),
  SignalList: composite('SignalScannerPage: normalized signal cards', 'scanner'),
  AssetSearchResults: composite('UnifiedAssetSearch'),
  MarketRankings: composite('SearchPage / MarketInformationPage'),
  ThemeSummary: composite('ThemesPage'),
  AiChart: exact('AiChartPage / UnifiedAnalysisChart', 'chart'),
  AiOpinion: composite('AiChartPage: current chart context and live judgment', 'chart'),
  AiReason: composite('AiChartPage: analysis reasons', 'chart'),
  AiChat: exact('AiChatPage'),
  PositionSummary: adapter(
    'getPortfolioChartOverlay / PortfolioPage',
    'position',
    'Read-only adapter reuses the existing portfolio overlay cache. It does not query account, broker, private trading, or order APIs.',
  ),
  PositionDetail: composite('PortfolioPage'),
  PositionOpinion: composite('TradingAiReviewPanel / PortfolioPage'),
  PricePlan: composite('SignalScannerPage pricePlan / AiChartPage', 'chart'),
  TradeReviewButton: adapter(
    'ScannerApprovalComposer',
    'trade-review',
    'Fixed approval-mode Paper plan flow. Builder JSON cannot provide URL, method, adapter, amount logic, or approval bypass.',
  ),
  BuyReviewButton: adapter('ScannerApprovalComposer'),
  SellReviewButton: adapter('ScannerApprovalComposer'),
  LongReviewButton: adapter('ScannerApprovalComposer'),
  ShortReviewButton: adapter('ScannerApprovalComposer'),
  PortfolioPositions: composite('PortfolioPage'),
  PnLSummary: composite('PortfolioPage'),
  RiskSummary: composite('TradingRiskPreviewPanel / PortfolioPage'),
  NewsSummary: composite('NewsTab / StockInfoPage'),
  DisclosureSummary: composite('DisclosureTab / StockInfoPage'),
  FinancialSummary: composite('FinancialTab / StockInfoPage'),
  TechnicalSummary: composite('AiChartPage / StockInfoPage'),
  AutoTradingStatus: composite('AutoTradingPage / TradeApprovalQueue'),
  AutoTradingStrategy: composite('TradeAutomationSettings'),
  AutoTradingRisk: composite('TradingRiskPreviewPanel / AutoTradingPage'),
  AutomationControl: adapter('TradeAutomationSettings'),
  EmergencyStop: composite(
    'AutoTradingPage safety state / server Risk Engine',
    null,
    'No Builder-provided execution binding is allowed. Existing server-side safety remains authoritative.',
  ),
  SettingsNavigation: composite('MorePage'),
  SettingCategory: composite('MorePage'),
  ProviderStatus: adapter('ScannerReadinessStatus / provider status surfaces'),
  AccountConnectionStatus: adapter('BrokerageAccountConnections'),
  SystemStatus: composite('ScannerReadinessStatus / OfflineBanner'),
  AdvancedInfo: composite('MorePage / diagnostic read-only surfaces'),
};

export function registryMappingCounts(): Record<RegistryMappingClassification, number> {
  const counts: Record<RegistryMappingClassification, number> = {
    EXISTING_EXACT: 0,
    EXISTING_ADAPTER_REQUIRED: 0,
    EXISTING_COMPOSITE_REQUIRED: 0,
    MOCK_ONLY: 0,
    MISSING: 0,
    FORBIDDEN_RUNTIME_BINDING: 0,
  };
  for (const entry of Object.values(UI_BUILDER_REGISTRY_MAPPING)) counts[entry.classification] += 1;
  return counts;
}

const SAFE_ACTION_IDS: Partial<Record<UiBuilderBlockType, string>> = {
  TradeReviewButton: 'TRADE_REVIEW',
  BuyReviewButton: 'TRADE_REVIEW_BUY',
  SellReviewButton: 'TRADE_REVIEW_SELL',
  LongReviewButton: 'TRADE_REVIEW_LONG',
  ShortReviewButton: 'TRADE_REVIEW_SHORT',
  AutomationControl: 'AUTOMATION_REVIEW_CONTROL',
};

const DENSITIES = new Set<UiBuilderDensity>(['compact', 'normal', 'detailed']);
const CARD_STYLES = new Set<UiBuilderCardStyle>(['flat', 'outlined', 'elevated']);
const VISIBILITY_MODES = new Set<UiBuilderVisibilityMode>(['both', 'mobile', 'desktop', 'hidden']);
const BLOCK_TYPE_SET = new Set<string>(UI_BUILDER_BLOCK_TYPES);
const ALLOWED_BLOCK_KEYS = new Set(['id', 'type', 'props', 'layout', 'visibility', 'actionId']);
const ALLOWED_PROP_KEYS = new Set([
  'title',
  'subtitle',
  'density',
  'collapsedByDefault',
  'expandable',
  'cardStyle',
]);
const ALLOWED_LAYOUT_KEYS = new Set(['order', 'colSpan', 'minHeight', 'sticky', 'bottomFixed']);
const ALLOWED_VISIBILITY_KEYS = new Set(['mode', 'hidden']);
const SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|(?:sk|ghp|github_pat)_[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
const URL_OR_API_VALUE = /(?:https?:\/\/|\/api\/|wss?:\/\/)/i;

export type UiBuilderValidationIssue = {
  code: string;
  message: string;
  blockId?: string;
};

export type UiBuilderValidationResult = {
  valid: boolean;
  issues: UiBuilderValidationIssue[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ownKeysAllowed(
  value: Record<string, unknown>,
  allowed: Set<string>,
  issues: UiBuilderValidationIssue[],
  code: string,
  blockId?: string,
) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      issues.push({ code, message: `허용되지 않은 속성입니다: ${key}`, blockId });
    }
  }
}

function validateText(value: unknown, label: string, issues: UiBuilderValidationIssue[], blockId?: string) {
  if (typeof value !== 'string') {
    issues.push({ code: 'INVALID_TEXT_PROP', message: `${label}은 문자열이어야 합니다.`, blockId });
    return;
  }
  if (SECRET_VALUE.test(value)) {
    issues.push({ code: 'SECRET_TOKEN_REJECTED', message: `${label}에 secret/token 형태의 값이 포함될 수 없습니다.`, blockId });
  }
  if (URL_OR_API_VALUE.test(value)) {
    issues.push({ code: 'URL_API_BINDING_REJECTED', message: `${label}에 URL/API 경로를 넣을 수 없습니다.`, blockId });
  }
}

function isVisibleForDevice(block: UiBuilderLayoutBlock, deviceClass: UiBuilderDeviceClass): boolean {
  if (block.visibility.hidden || block.visibility.mode === 'hidden') return false;
  return block.visibility.mode === 'both' || block.visibility.mode === deviceClass;
}

export function validateUiBuilderSignalScannerLayout(
  candidate: unknown,
  expectedDevice: UiBuilderDeviceClass,
): UiBuilderValidationResult {
  const issues: UiBuilderValidationIssue[] = [];
  if (!isRecord(candidate)) return { valid: false, issues: [{ code: 'INVALID_LAYOUT', message: 'Layout은 object여야 합니다.' }] };

  const doc = candidate as Record<string, unknown>;
  if (doc.schemaVersion !== UI_BUILDER_SCHEMA_VERSION) {
    issues.push({ code: 'UNSUPPORTED_SCHEMA_VERSION', message: `schemaVersion ${String(doc.schemaVersion)}은 지원되지 않습니다.` });
  }
  if (doc.pageId !== 'SIGNAL_SCANNER') {
    issues.push({ code: 'UNSUPPORTED_PAGE', message: `SIGNAL_SCANNER layout만 이 Phase에서 지원합니다.` });
  }
  if (doc.deviceClass !== expectedDevice) {
    issues.push({ code: 'DEVICE_CLASS_MISMATCH', message: `${expectedDevice} layout이 아닙니다.` });
  }
  if (!Array.isArray(doc.blocks)) {
    issues.push({ code: 'INVALID_BLOCKS', message: 'blocks 배열이 필요합니다.' });
    return { valid: false, issues };
  }

  const ids = new Set<string>();
  const uniqueTypes = new Set<string>();
  const orders = new Set<number>();
  let visiblePageHeader = false;

  for (const raw of doc.blocks) {
    if (!isRecord(raw)) {
      issues.push({ code: 'INVALID_BLOCK', message: 'block은 object여야 합니다.' });
      continue;
    }
    const blockId = typeof raw.id === 'string' ? raw.id : undefined;
    ownKeysAllowed(raw, ALLOWED_BLOCK_KEYS, issues, 'FORBIDDEN_BLOCK_PROP', blockId);

    if (!blockId || !blockId.trim()) issues.push({ code: 'INVALID_BLOCK_ID', message: 'block id가 필요합니다.' });
    else if (ids.has(blockId)) issues.push({ code: 'DUPLICATE_BLOCK_ID', message: `중복 block id: ${blockId}`, blockId });
    else ids.add(blockId);

    if (typeof raw.type !== 'string' || !BLOCK_TYPE_SET.has(raw.type)) {
      issues.push({ code: 'UNKNOWN_COMPONENT', message: `Registry에 없는 component: ${String(raw.type)}`, blockId });
      continue;
    }
    const type = raw.type as UiBuilderBlockType;
    if (type !== 'SettingCategory' && type !== 'AdvancedInfo') {
      if (uniqueTypes.has(type)) issues.push({ code: 'DUPLICATE_UNIQUE_COMPONENT', message: `중복 unique component: ${type}`, blockId });
      uniqueTypes.add(type);
    }

    if (!isRecord(raw.props)) {
      issues.push({ code: 'INVALID_PROPS', message: 'props object가 필요합니다.', blockId });
    } else {
      ownKeysAllowed(raw.props, ALLOWED_PROP_KEYS, issues, 'FORBIDDEN_RUNTIME_PROP', blockId);
      validateText(raw.props.title, 'title', issues, blockId);
      if (raw.props.subtitle !== undefined) validateText(raw.props.subtitle, 'subtitle', issues, blockId);
      if (!DENSITIES.has(raw.props.density as UiBuilderDensity)) issues.push({ code: 'INVALID_DENSITY', message: 'density 값이 올바르지 않습니다.', blockId });
      if (typeof raw.props.collapsedByDefault !== 'boolean') issues.push({ code: 'INVALID_COLLAPSED', message: 'collapsedByDefault는 boolean이어야 합니다.', blockId });
      if (typeof raw.props.expandable !== 'boolean') issues.push({ code: 'INVALID_EXPANDABLE', message: 'expandable은 boolean이어야 합니다.', blockId });
      if (!CARD_STYLES.has(raw.props.cardStyle as UiBuilderCardStyle)) issues.push({ code: 'INVALID_CARD_STYLE', message: 'cardStyle 값이 올바르지 않습니다.', blockId });
    }

    if (!isRecord(raw.layout)) {
      issues.push({ code: 'INVALID_BLOCK_LAYOUT', message: 'layout object가 필요합니다.', blockId });
    } else {
      ownKeysAllowed(raw.layout, ALLOWED_LAYOUT_KEYS, issues, 'FORBIDDEN_LAYOUT_PROP', blockId);
      const order = raw.layout.order;
      const colSpan = raw.layout.colSpan;
      if (!Number.isInteger(order) || Number(order) < 0) issues.push({ code: 'INVALID_ORDER', message: 'order는 0 이상의 정수여야 합니다.', blockId });
      else if (orders.has(Number(order))) issues.push({ code: 'DUPLICATE_ORDER', message: `중복 order: ${String(order)}`, blockId });
      else orders.add(Number(order));
      if (!Number.isInteger(colSpan) || Number(colSpan) < 1 || Number(colSpan) > 12) issues.push({ code: 'INVALID_COLUMN_SPAN', message: 'colSpan은 1~12 정수여야 합니다.', blockId });
      if (!Number.isFinite(Number(raw.layout.minHeight)) || Number(raw.layout.minHeight) < 0) issues.push({ code: 'INVALID_MIN_HEIGHT', message: 'minHeight가 올바르지 않습니다.', blockId });
      if (typeof raw.layout.sticky !== 'boolean' || typeof raw.layout.bottomFixed !== 'boolean') issues.push({ code: 'INVALID_LAYOUT_FLAGS', message: 'sticky/bottomFixed는 boolean이어야 합니다.', blockId });
    }

    if (!isRecord(raw.visibility)) {
      issues.push({ code: 'INVALID_VISIBILITY', message: 'visibility object가 필요합니다.', blockId });
    } else {
      ownKeysAllowed(raw.visibility, ALLOWED_VISIBILITY_KEYS, issues, 'FORBIDDEN_VISIBILITY_PROP', blockId);
      if (!VISIBILITY_MODES.has(raw.visibility.mode as UiBuilderVisibilityMode)) issues.push({ code: 'INVALID_VISIBILITY_MODE', message: 'visibility.mode가 올바르지 않습니다.', blockId });
      if (typeof raw.visibility.hidden !== 'boolean') issues.push({ code: 'INVALID_VISIBILITY_HIDDEN', message: 'visibility.hidden은 boolean이어야 합니다.', blockId });
    }

    const expectedActionId = SAFE_ACTION_IDS[type];
    if (expectedActionId && raw.actionId !== expectedActionId) {
      issues.push({ code: 'SAFE_ACTION_MUTATION_REJECTED', message: `${type} actionId는 ${expectedActionId}로 고정됩니다.`, blockId });
    }
    if (!expectedActionId && raw.actionId !== undefined) {
      issues.push({ code: 'ARBITRARY_ACTION_REJECTED', message: `${type}에는 actionId를 지정할 수 없습니다.`, blockId });
    }

    const typedBlock = raw as unknown as UiBuilderLayoutBlock;
    if (type === 'PageHeader' && isRecord(raw.visibility) && isVisibleForDevice(typedBlock, expectedDevice)) {
      visiblePageHeader = true;
    }
  }

  if (!visiblePageHeader) {
    issues.push({ code: 'REQUIRED_BLOCK_MISSING', message: 'PageHeader는 SIGNAL_SCANNER에서 숨기거나 삭제할 수 없습니다.' });
  }

  return { valid: issues.length === 0, issues };
}

export function signalScannerPublishedLayoutStorageKey(deviceClass: UiBuilderDeviceClass): string {
  return `stock-ui-builder:published-layout:SIGNAL_SCANNER:${deviceClass}`;
}

export function readStoredUiBuilderSignalScannerLayout(deviceClass: UiBuilderDeviceClass): unknown {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(signalScannerPublishedLayoutStorageKey(deviceClass));
}

export type UiBuilderLayoutLoadResult = {
  source: 'builder' | 'fallback';
  layout: UiBuilderLayoutDocument;
  issues: UiBuilderValidationIssue[];
};

export function loadUiBuilderSignalScannerLayout(
  raw: unknown,
  expectedDevice: UiBuilderDeviceClass,
  fallback: UiBuilderLayoutDocument,
): UiBuilderLayoutLoadResult {
  let candidate: unknown = raw;
  if (typeof raw === 'string') {
    try {
      candidate = JSON.parse(raw);
    } catch {
      return {
        source: 'fallback',
        layout: structuredClone(fallback),
        issues: [{ code: 'INVALID_JSON', message: 'Layout JSON을 파싱할 수 없습니다.' }],
      };
    }
  }
  const result = validateUiBuilderSignalScannerLayout(candidate, expectedDevice);
  if (!result.valid) return { source: 'fallback', layout: structuredClone(fallback), issues: result.issues };
  return { source: 'builder', layout: structuredClone(candidate as UiBuilderLayoutDocument), issues: [] };
}

const MOBILE_BLOCKS: Array<[UiBuilderBlockType, number]> = [
  ['PageHeader', 12],
  ['MarketSelector', 12],
  ['StrategySelector', 12],
  ['TimeframeSelector', 12],
  ['DirectionSelector', 12],
  ['SignalSummary', 12],
  ['SignalList', 12],
  ['PositionSummary', 12],
  ['TradeReviewButton', 12],
];

const DESKTOP_BLOCKS: Array<[UiBuilderBlockType, number]> = [
  ['PageHeader', 12],
  ['MarketSelector', 3],
  ['StrategySelector', 3],
  ['TimeframeSelector', 3],
  ['DirectionSelector', 3],
  ['SignalList', 4],
  ['AiChart', 5],
  ['AiOpinion', 3],
  ['PositionSummary', 3],
  ['PricePlan', 3],
  ['TradeReviewButton', 3],
  ['SignalSummary', 3],
];

function safeActionIdFor(type: UiBuilderBlockType) {
  return SAFE_ACTION_IDS[type];
}

function makeSignalScannerLayout(
  deviceClass: UiBuilderDeviceClass,
  specs: Array<[UiBuilderBlockType, number]>,
): UiBuilderLayoutDocument {
  const now = '2026-08-10T00:00:00.000Z';
  return {
    schemaVersion: UI_BUILDER_SCHEMA_VERSION,
    layoutId: `signal-scanner-integration-${deviceClass}`,
    pageId: 'SIGNAL_SCANNER',
    deviceClass,
    version: 1,
    status: 'published',
    createdAt: now,
    updatedAt: now,
    publishedAt: now,
    blocks: specs.map(([type, colSpan], order) => ({
      id: `${type.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, '')}-${order + 1}`,
      type,
      props: {
        title: type === 'PageHeader' ? 'AI 신호검색기' : type,
        density: type === 'SignalList' || type === 'AiChart' ? 'detailed' : 'compact',
        collapsedByDefault: false,
        expandable: false,
        cardStyle: 'outlined',
      },
      layout: {
        order,
        colSpan,
        minHeight: type === 'AiChart' ? 420 : type === 'SignalList' ? 360 : 88,
        sticky: false,
        bottomFixed: false,
      },
      visibility: { mode: 'both', hidden: false },
      ...(safeActionIdFor(type) ? { actionId: safeActionIdFor(type) } : {}),
    })),
  };
}

export const SIGNAL_SCANNER_INTEGRATION_LAYOUTS: Record<UiBuilderDeviceClass, UiBuilderLayoutDocument> = {
  mobile: makeSignalScannerLayout('mobile', MOBILE_BLOCKS),
  desktop: makeSignalScannerLayout('desktop', DESKTOP_BLOCKS),
};

export type ScannerSurfacePlanItem = {
  surface: Exclude<ScannerRuntimeSurface, null>;
  order: number;
  colSpan: number;
  blockTypes: UiBuilderBlockType[];
};

const SURFACE_ANCHOR: Record<Exclude<ScannerRuntimeSurface, null>, UiBuilderBlockType> = {
  scanner: 'SignalList',
  chart: 'AiChart',
  position: 'PositionSummary',
  'trade-review': 'TradeReviewButton',
};

export function scannerSurfacePlan(layout: UiBuilderLayoutDocument): ScannerSurfacePlanItem[] {
  const visible = layout.blocks
    .filter((block) => isVisibleForDevice(block, layout.deviceClass))
    .sort((left, right) => left.layout.order - right.layout.order);

  const groups = new Map<Exclude<ScannerRuntimeSurface, null>, UiBuilderLayoutBlock[]>();
  for (const block of visible) {
    const surface = UI_BUILDER_REGISTRY_MAPPING[block.type].scannerSurface;
    if (!surface) continue;
    const current = groups.get(surface) ?? [];
    current.push(block);
    groups.set(surface, current);
  }

  return [...groups.entries()]
    .map(([surface, blocks]) => {
      const anchor = blocks.find((block) => block.type === SURFACE_ANCHOR[surface]) ?? blocks[0];
      return {
        surface,
        order: Math.min(...blocks.map((block) => block.layout.order)),
        colSpan: layout.deviceClass === 'mobile' ? 12 : anchor.layout.colSpan,
        blockTypes: blocks.map((block) => block.type),
      };
    })
    .sort((left, right) => left.order - right.order);
}

export function signalScannerLayoutHasUnsupportedRuntimeBlocks(layout: UiBuilderLayoutDocument): UiBuilderBlockType[] {
  return layout.blocks
    .filter((block) => isVisibleForDevice(block, layout.deviceClass))
    .filter((block) => UI_BUILDER_REGISTRY_MAPPING[block.type].scannerSurface === null)
    .map((block) => block.type);
}
