import { Router } from 'express';
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

const router = Router();
router.use(requireMember, requireAdmin);

const PAGE_COMPONENTS: Record<string, Set<string>> = {
  settings: new Set([
    'settings.account-assets',
    'settings.screen',
    'settings.notifications',
    'settings.alert-types',
    'settings.ai-repair',
    'settings.backup',
    'settings.footer',
  ]),
};

type UiSection = {
  id: string;
  component: string;
  visible: boolean;
  order: number;
  width: 'full' | 'half';
  height: 'auto' | 'compact' | 'tall';
  spacing: 'none' | 'sm' | 'md' | 'lg';
  title?: string;
};

type UiLayout = {
  schemaVersion: 1;
  pageKey: string;
  sections: UiSection[];
};

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

function normalizeLayout(value: unknown, pageKey: string): UiLayout | null {
  if (!value || typeof value !== 'object') return null;

  const source = value as Record<string, unknown>;
  if (source.schemaVersion !== 1 || source.pageKey !== pageKey) return null;
  if (!Array.isArray(source.sections) || source.sections.length > 50) return null;

  const allowed = PAGE_COMPONENTS[pageKey];
  const seen = new Set<string>();
  const sections: UiSection[] = [];

  for (const raw of source.sections) {
    if (!raw || typeof raw !== 'object') return null;
    const section = raw as Record<string, unknown>;
    const id = String(section.id ?? '').trim();
    const component = String(section.component ?? '').trim();

    if (!/^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id)) return null;
    if (seen.has(id) || !allowed.has(component)) return null;
    seen.add(id);

    const width = section.width === 'half' ? 'half' : 'full';
    const height =
      section.height === 'compact' || section.height === 'tall'
        ? section.height
        : 'auto';
    const spacing =
      section.spacing === 'none' ||
      section.spacing === 'sm' ||
      section.spacing === 'lg'
        ? section.spacing
        : 'md';

    const title =
      typeof section.title === 'string'
        ? section.title.trim().slice(0, 80)
        : undefined;

    sections.push({
      id,
      component,
      visible: section.visible !== false,
      order: Number.isFinite(Number(section.order))
        ? Math.max(0, Math.min(999, Number(section.order)))
        : sections.length,
      width,
      height,
      spacing,
      ...(title ? { title } : {}),
    });
  }

  sections.sort((a, b) => a.order - b.order);
  sections.forEach((section, index) => {
    section.order = index;
  });

  return {
    schemaVersion: 1,
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
    // 감사 로그 실패가 UI 저장을 맋집지는 않니다.
  }
}

router.get('/:pageKey', async (req: AuthenticatedRequest, res) => {
  const pageKey = validPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ error: 'INVALID_UI_PAGE' });

  const { data, error } = await adminDb(req)
    .from('ui_layout_versions')
    .select(
      'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
    )
    .eq('page_key', pageKey)
    .order('version', { ascending: false })
    .limit(100);

  if (error) {
    return res.status(503).json({ error: 'UI_LAYOUT_STORAGE_NOT_READY' });
  }

  return res.json({ versions: data ?? [] });
});

router.post('/:pageKey/drafts', async (req: AuthenticatedRequest, res) => {
  const pageKey = validPageKey(req.params.pageKey);
  if (!pageKey) return res.status(400).json({ error: 'INVALID_UI_PAGE' });

  const layout = normalizeLayout(req.body?.layout, pageKey);
  if (!layout) return res.status(400).json({ error: 'INVALID_UI_LAYOUT' });

  try {
    const version = await nextVersion(req, pageKey);
    const note =
      typeof req.body?.note === 'string'
        ? req.body.note.trim().slice(0, 200)
        : null;

    const { data, error } = await adminDb(req)
      .from('ui_layout_versions')
      .insert({
        page_key: pageKey,
        version,
        status: 'draft',
        schema_version: 1,
        layout,
        note,
        created_by: req.member?.id,
      })
      .select(
        'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
      )
      .single();

    if (error) {
      return res.status(503).json({ error: 'UI_LAYOUT_SAVE_FAILED' });
    }

    await audit(req, 'ui-layout.draft.create', pageKey, data.id, { version });
    return res.status(201).json({ version: data });
  } catch {
    return res.status(503).json({ error: 'UI_LAYOUT_SAVE_FAILED' });
  }
});

router.post('/:pageKey/:id/publish', async (req: AuthenticatedRequest, res) => {
  const pageKey = validPageKey(req.params.pageKey);
  const id = validId(req.params.id);
  if (!pageKey || !id) {
    return res.status(400).json({ error: 'INVALID_UI_LAYOUT_VERSION' });
  }

  const db = adminDb(req);
  const { data: target, error: targetError } = await db
    .from('ui_layout_versions')
    .select('id,version,layout')
    .eq('id', id)
    .eq('page_key', pageKey)
    .maybeSingle();

  if (targetError) {
    return res.status(503).json({ error: 'UI_LAYOUT_STORAGE_NOT_READY' });
  }
  if (!target) return res.status(404).json({ error: 'UI_LAYOUT_NOT_FOUND' });

  const now = new Date().toISOString();
  const { error: archiveError } = await db
    .from('ui_layout_versions')
    .update({ status: 'archived' })
    .eq('page_key', pageKey)
    .eq('status', 'published')
    .neq('id', id);

  if (archiveError) {
    return res.status(503).json({ error: 'UI_LAYOUT_PUBLISH_FAILED' });
  }

  const { data, error } = await db
    .from('ui_layout_versions')
    .update({ status: 'published', published_at: now })
    .eq('id', id)
    .eq('page_key', pageKey)
    .select(
      'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
    )
    .single();

  if (error) {
    return res.status(503).json({ error: 'UI_LAYOUT_PUBLISF_FAILED' });
  }

  await audit(req, 'ui-layout.publish', pageKey, id, {
    version: target.version,
  });
  return res.json({ version: data });
});

router.post('/:pageKey/:id/rollback', async (req: AuthenticatedRequest, res) => {
  const pageKey = validPageKey(req.params.pageKey);
  const id = validId(req.params.id);
  if (!pageKey || !id) {
    return res.status(400).json({ error: 'INVALID_UI_LAYOUT_VERSION' });
  }

  const { data: source, error: sourceError } = await adminDb(req)
    .from('ui_layout_versions')
    .select('id,version,layout')
    .eq('id', id)
    .eq('page_key', pageKey)
    .maybeSingle();

  if (sourceError) {
    return res.status(503).json({ error: 'UI_LAYOUT_STORAGE_NOT_READY' });
  }
  if (!source) return res.status(404).json({ error: 'UI_LAYOUT_NOT_FOUND' });

  try {
    const version = await nextVersion(req, pageKey);
    const { data, error } = await adminDb(req)
      .from('ui_layout_versions')
      .insert({
        page_key: pageKey,
        version,
        status: 'draft',
        schema_version: 1,
        layout: source.layout,
        note: `v${source.version}에서 복원한 초안`,
        created_by: req.member?.id,
      })
      .select(
        'id,page_key,version,status,schema_version,layout,note,created_by,created_at,published_at',
      )
      .single();

    if (error) {
      return res.status(503).json({ error: 'UI_LAYOUT_ROLLBACK_FAILED' });
    }

    await audit(req, 'ui-layout.rollback', pageKey, data.id, {
      sourceVersion: source.version,
      version,
    });
    return res.status(201).json({ version: data });
  } catch {
    return res.status(503).json({ error: 'UI_LAYOUT_ROLLBACK_FAILED' });
  }
});

export default router;
