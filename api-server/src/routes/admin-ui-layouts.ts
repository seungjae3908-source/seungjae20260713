import { Router, type Response } from 'express';
import {
  requireAdmin,
  requireMember,
  type AuthenticatedRequest,
} from '../middleware/auth';
import {
  getSupabase,
  getUserSupabase,
  hasSupabaseServerKey,
} from '../lib/supabase';
import {
  createFileDraft,
  listFileLayouts,
  publishFileLayout,
  rollbackFileLayout,
} from '../lib/ui-layout-file-store';

const router = Router();
router.use(requireMember, requireAdmin);

const PAGE_COMPONENTS: Record<string, Set<string>> = {
  home: new Set([
    'home.header',
    'home.market-summary',
    'home.live-index',
    'home.market-briefing',
    'home.issues',
  ]),
  stocks: new Set([
    'stocks.header',
    'stocks.search',
    'stocks.market-tabs',
    'stocks.rankings',
    'stocks.list',
  ]),
  'stock-info': new Set([
    'stock-info.header',
    'stock-info.quote',
    'stock-info.chart',
    'stock-info.analysis',
    'stock-info.financials',
    'stock-info.news',
  ]),
  tech: new Set([
    'tech.header',
    'tech.shortcuts',
    'tech.signal',
    'tech.chart',
    'tech.auto',
  ]),
  'signal-scan': new Set([
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
  ]),
  portfolio: new Set([
    'portfolio.header',
    'portfolio.summary',
    'portfolio.holdings',
    'portfolio.cash',
    'portfolio.plan',
  ]),
  navigation: new Set([
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
  settings: new Set([
    'settings.header',
    'settings.account-assets',
    'settings.screen',
    'settings.notifications',
    'settings.alert-types',
    'settings.admin-tools',
    'settings.ai-repair',
    'settings.backup',
    'settings.footer',
  ]),
};

const ALLOWED_ROUTES = new Set([
  '/home',
  '/search',
  '/stocks',
  '/stocks/kr',
  '/stocks/us',
  '/coins/spot',
  '/coins/futures',
  '/watchlist',
  '/watchlist/assets?view=watchlist&asset=stockKR',
  '/watchlist/assets?view=watchlist&asset=stockUS',
  '/watchlist/assets?view=watchlist&asset=coinSpot',
  '/watchlist/assets?view=watchlist&asset=coinFutures',
  '/watchlist/assets?view=alerts&asset=stockKR',
  '/watchlist/assets?view=alerts&asset=stockUS',
  '/watchlist/assets?view=alerts&asset=coinSpot',
  '/watchlist/assets?view=alerts&asset=coinFutures',
  '/tech',
  '/tech/signal-scan',
  '/tech/chart-relay?asset=stockKR&tab=live&focused=1',
  '/tech/chart-relay?asset=stockUS&tab=live&focused=1',
  '/tech/chart-relay?asset=coinSpot&tab=live&focused=1',
  '/tech/chart-relay?asset=coinFutures&tab=live&focused=1',
  '/tech/auto-trade',
  '/portfolio',
  '/portfolio/summary?asset=all&source=info',
  '/portfolio/summary?asset=all&source=portfolio',
  '/stock-info',
  '/stock-info?asset=stock&market=KR&focused=1',
  '/stock-info?asset=stock&market=US&focused=1',
  '/stock-info?asset=coin&coinMarket=spot&focused=1',
  '/stock-info?asset=coin&coinMarket=futures&focused=1',
  '/learn',
  '/analysis/KR',
  '/analysis/US',
  '/settings',
  '/more',
  '/account',
]);

const ALLOWED_APIS = new Set([
  '/api/health',
  '/api/market/summary',
  '/api/search?q=삼성전자',
  '/api/portfolio',
]);

const NODE_KINDS = new Set([
  'section',
  'tab',
  'button',
  'text',
  'item',
  'card',
  'popup',
]);
const WIDTHS = new Set(['full', 'half', 'third', 'auto']);
const HEIGHTS = new Set(['auto', 'compact', 'normal', 'tall']);
const SPACINGS = new Set(['none', 'xs', 'sm', 'md', 'lg', 'xl']);
const ALIGNS = new Set(['left', 'center', 'right']);
const FONT_SIZES = new Set(['xs', 'sm', 'md', 'lg', 'xl', '2xl']);
const FONT_WEIGHTS = new Set(['normal', 'medium', 'bold', 'black']);
const RADII = new Set(['none', 'sm', 'md', 'lg', 'xl', 'full']);
const SOURCE_TYPES = new Set(['none', 'route', 'api', 'component']);
const POPUP_POSITIONS = new Set(['center', 'bottom', 'top']);

function adminDb(req: AuthenticatedRequest) {
  return hasSupabaseServerKey()
    ? getSupabase()
    : getUserSupabase(req.accessToken!);
}

function validPageKey(value: unknown): string | null {
  const pageKey = String(value ?? '').trim();
  return Object.hasOwn(PAGE_COMPONENTS, pageKey) ? pageKey : null;
}

function validId(value: unknown): string | null {
  const id = String(value ?? '').trim();
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

function text(value: unknown, max: number) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function enumValue(value: unknown, allowed: Set<string>, fallback: string) {
  const normalized = String(value ?? '');
  return allowed.has(normalized) ? normalized : fallback;
}

function color(value: unknown) {
  const normalized = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(normalized) ? normalized.toUpperCase() : '';
}

function numberValue(value: unknown, min: number, max: number, fallback = 0) {
  const normalized = Number(value);
  return Number.isFinite(normalized)
    ? Math.round(Math.max(min, Math.min(max, normalized)))
    : fallback;
}

function normalizeLayout(value: unknown, pageKey: string) {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  if (source.pageKey !== pageKey) return null;
  if (!Array.isArray(source.sections) || source.sections.length > 80) return null;

  const allowed = PAGE_COMPONENTS[pageKey];
  const seen = new Set<string>();
  const sections: Array<Record<string, unknown>> = [];

  for (const raw of source.sections) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    const id = text(item.id, 80);
    const component = text(item.component, 100);
    const custom = item.custom === true || component.startsWith('custom.');

    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)) return null;
    if (seen.has(id)) return null;
    if (!custom && !allowed.has(component)) return null;
    if (custom && !component.startsWith('custom.')) return null;
    seen.add(id);

    const sourceType = enumValue(item.sourceType, SOURCE_TYPES, 'none');
    const sourcePath = text(item.sourcePath, 220);
    const sourceKey = text(item.sourceKey, 100);

    if (sourceType === 'route' && !ALLOWED_ROUTES.has(sourcePath)) return null;
    if (sourceType === 'api' && !ALLOWED_APIS.has(sourcePath)) return null;
    if (
      sourceType === 'component' &&
      !Object.values(PAGE_COMPONENTS).some((set) => set.has(sourceKey))
    ) {
      return null;
    }

    sections.push({
      id,
      component,
      kind: enumValue(item.kind, NODE_KINDS, custom ? 'card' : 'section'),
      parentId: text(item.parentId, 80) || null,
      visible: item.visible !== false,
      order: numberValue(item.order, 0, 999, sections.length),
      width: enumValue(item.width, WIDTHS, 'full'),
      height: enumValue(item.height, HEIGHTS, 'auto'),
      spacing: enumValue(item.spacing, SPACINGS, 'md'),
      align: enumValue(item.align, ALIGNS, 'center'),
      fontSize: enumValue(item.fontSize, FONT_SIZES, 'md'),
      fontWeight: enumValue(item.fontWeight, FONT_WEIGHTS, 'black'),
      opacity: [25, 50, 75, 100].includes(Number(item.opacity))
        ? Number(item.opacity)
        : 100,
      title: text(item.title, 120),
      route: ALLOWED_ROUTES.has(text(item.route, 220)) ? text(item.route, 220) : '',
      custom,
      backgroundColor: color(item.backgroundColor),
      textColor: color(item.textColor),
      borderColor: color(item.borderColor),
      radius: enumValue(item.radius, RADII, 'xl'),
      x: numberValue(item.x, -240, 240),
      y: numberValue(item.y, -400, 400),
      zIndex: numberValue(item.zIndex, 0, 50),
      sourceType,
      sourceKey,
      sourcePath,
      popupTitle: text(item.popupTitle, 120),
      popupContent: text(item.popupContent, 2000),
      popupPosition: enumValue(item.popupPosition, POPUP_POSITIONS, 'center'),
    });
  }

  const sectionIds = new Set(sections.map((section) => String(section.id)));
  for (const section of sections) {
    const parentId = section.parentId ? String(section.parentId) : '';
    if (parentId && (!sectionIds.has(parentId) || parentId === section.id)) return null;
  }

  sections.sort((a, b) => Number(a.order) - Number(b.order));
  sections.forEach((section, index) => {
    section.order = index;
  });

  return {
    schemaVersion: 2,
    pageKey,
    sections,
  };
}

async function nextVersion(req: AuthenticatedRequest, pageKey: string) {
  const { data, error } = await adminDb(req)
    .from('ui_layout_versions')
    .select('version')
    .eq('page_key', pageKey)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return Number(data?.version ?? 0) + 1;
}

async function listVersions(req: AuthenticatedRequest, pageKey: string) {
  const { data, error } = await adminDb(req)
    .from('ui_layout_versions')
    .select(
      'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
    )
    .eq('page_key', pageKey)
    .order('version', { ascending: false })
    .limit(100);
  if (error) throw error;
  return data ?? [];
}

async function audit(
  req: AuthenticatedRequest,
  action: string,
  pageKey: string,
  versionId: string,
  details: Record<string, unknown>,
) {
  try {
    await getSupabase().from('audit_logs').insert({
      actor_id: req.member?.id,
      action,
      target_type: 'ui_layout',
      target_id: versionId,
      details: { pageKey, ...details },
      ip_address: req.ip,
    });
  } catch {
    // 감사 로그 실패는 UI 저장을 막지 않습니다.
  }
}

router.get('/:pageKey', async (req: AuthenticatedRequest, res) => {
  const pageKey = validPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ error: 'INVALID_UI_PAGE' });

  try {
    const versions = await listVersions(req, pageKey);
    const draft = versions.find((item) => item.status === 'draft') ?? null;
    const published = versions.find((item) => item.status === 'published') ?? null;
    return res.json({
      versions,
      draft,
      published,
      layout: draft?.layout ?? published?.layout ?? null,
    });
  } catch {
    const versions = listFileLayouts(pageKey);
    const draft = versions.find((item) => item.status === 'draft') ?? null;
    const published = versions.find((item) => item.status === 'published') ?? null;
    return res.json({ versions, draft, published, layout: draft?.layout ?? published?.layout ?? null, storage: 'local-fallback' });
  }
});

async function createDraft(req: AuthenticatedRequest, res: Response) {
  const pageKey = validPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ error: 'INVALID_UI_PAGE' });
  const layout = normalizeLayout(req.body?.layout, pageKey);
  if (!layout) return res.status(400).json({ error: 'INVALID_UI_LAYOUT' });

  try {
    const version = await nextVersion(req, pageKey);
    const { data, error } = await adminDb(req)
      .from('ui_layout_versions')
      .insert({
        page_key: pageKey,
        version,
        status: 'draft',
        schema_version: 2,
        layout,
        note: text(req.body?.note, 200) || null,
        created_by: req.member?.id,
      })
      .select(
        'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
      )
      .single();
    if (error) throw error;
    await audit(req, 'ui-layout.draft.create', pageKey, data.id, { version });
    const versions = await listVersions(req, pageKey);
    return res.status(201).json({ draft: data, version: data, versions });
  } catch {
    const draft = createFileDraft(pageKey, layout, text(req.body?.note, 200) || null, req.member?.id ?? null);
    const versions = listFileLayouts(pageKey);
    return res.status(201).json({ draft, version: draft, versions, storage: 'local-fallback' });
  }
}

router.post('/:pageKey/draft', createDraft);
router.post('/:pageKey/drafts', createDraft);

async function publishLayout(req: AuthenticatedRequest, res: Response) {
  const pageKey = validPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ error: 'INVALID_UI_PAGE' });

  const layout = normalizeLayout(req.body?.layout, pageKey);
  if (!layout) return res.status(400).json({ error: 'INVALID_UI_LAYOUT' });

  const requestedId = validId(req.params.id ?? req.body?.versionId ?? req.body?.version_id);
  const db = adminDb(req);

  try {
    let targetId = requestedId;
    let targetVersion = 0;

    if (targetId) {
      const { data: existing, error: existingError } = await db
        .from('ui_layout_versions')
        .select('id,version')
        .eq('id', targetId)
        .eq('page_key', pageKey)
        .maybeSingle();
      if (existingError) throw existingError;
      if (!existing) targetId = null;
      else {
        targetVersion = Number(existing.version);
        const { error: updateError } = await db
          .from('ui_layout_versions')
          .update({ layout, schema_version: 2 })
          .eq('id', targetId)
          .eq('page_key', pageKey);
        if (updateError) throw updateError;
      }
    }

    if (!targetId) {
      targetVersion = await nextVersion(req, pageKey);
      const { data: created, error: createError } = await db
        .from('ui_layout_versions')
        .insert({
          page_key: pageKey,
          version: targetVersion,
          status: 'draft',
          schema_version: 2,
          layout,
          created_by: req.member?.id,
        })
        .select('id')
        .single();
      if (createError) throw createError;
      targetId = created.id;
    }

    const { error: archiveError } = await db
      .from('ui_layout_versions')
      .update({ status: 'archived' })
      .eq('page_key', pageKey)
      .eq('status', 'published')
      .neq('id', targetId);
    if (archiveError) throw archiveError;

    const { data, error } = await db
      .from('ui_layout_versions')
      .update({ status: 'published', published_at: new Date().toISOString() })
      .eq('id', targetId)
      .eq('page_key', pageKey)
      .select(
        'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
      )
      .single();
    if (error) throw error;

    await audit(req, 'ui-layout.publish', pageKey, targetId!, {
      version: targetVersion,
    });
    const versions = await listVersions(req, pageKey);
    return res.json({ published: data, version: data, versions });
  } catch {
    const published = publishFileLayout(pageKey, layout, requestedId, req.member?.id ?? null);
    const versions = listFileLayouts(pageKey);
    return res.json({ published, version: published, versions, storage: 'local-fallback' });
  }
}

router.post('/:pageKey/publish', publishLayout);
router.post('/:pageKey/:id/publish', publishLayout);

async function rollbackLayout(req: AuthenticatedRequest, res: Response) {
  const pageKey = validPageKey(req.params.pageKey);
  const sourceId = validId(req.params.id ?? req.body?.versionId ?? req.body?.version_id);
  if (!pageKey || !sourceId) {
    return res.status(400).json({ error: 'INVALID_UI_LAYOUT_VERSION' });
  }

  try {
    const { data: source, error: sourceError } = await adminDb(req)
      .from('ui_layout_versions')
      .select('id,version,layout')
      .eq('id', sourceId)
      .eq('page_key', pageKey)
      .maybeSingle();
    if (sourceError) throw sourceError;
    if (!source) return res.status(404).json({ error: 'UI_LAYOUT_NOT_FOUND' });

    const layout = normalizeLayout(source.layout, pageKey);
    if (!layout) return res.status(400).json({ error: 'INVALID_UI_LAYOUT' });
    const version = await nextVersion(req, pageKey);
    const { data, error } = await adminDb(req)
      .from('ui_layout_versions')
      .insert({
        page_key: pageKey,
        version,
        status: 'draft',
        schema_version: 2,
        layout,
        note: `버전 ${source.version}에서 복원한 초안`,
        created_by: req.member?.id,
      })
      .select(
        'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
      )
      .single();
    if (error) throw error;

    await audit(req, 'ui-layout.rollback', pageKey, data.id, {
      sourceVersion: source.version,
      version,
    });
    const versions = await listVersions(req, pageKey);
    return res.status(201).json({ draft: data, version: data, versions });
  } catch {
    const draft = rollbackFileLayout(pageKey, sourceId, req.member?.id ?? null);
    if (!draft) return res.status(404).json({ error: 'UI_LAYOUT_NOT_FOUND' });
    const versions = listFileLayouts(pageKey);
    return res.status(201).json({ draft, version: draft, versions, storage: 'local-fallback' });
  }
}

router.post('/:pageKey/rollback', rollbackLayout);
router.post('/:pageKey/:id/rollback', rollbackLayout);

export default router;
