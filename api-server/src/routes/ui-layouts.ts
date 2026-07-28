import { Router } from 'express';
import { requireMember, type AuthenticatedRequest } from '../middleware/auth';
import {
  getSupabase,
  getUserSupabase,
  hasSupabaseServerKey,
} from '../lib/supabase';

const router = Router();
router.use(requireMember);

const ALLOWED_PAGES = new Set([
  'home',
  'stocks',
  'stock-info',
  'tech',
  'signal-scan',
  'portfolio',
  'settings',
]);

function memberDb(req: AuthenticatedRequest) {
  return hasSupabaseServerKey()
    ? getSupabase()
    : getUserSupabase(req.accessToken!);
}

router.get('/:pageKey/published', async (req: AuthenticatedRequest, res) => {
  const pageKey = String(req.params.pageKey ?? '').trim();
  if (!ALLOWED_PAGES.has(pageKey)) {
    return res.status(400).json({ error: 'INVALID_UI_PAGE' });
  }

  const { data, error } = await memberDb(req)
    .from('ui_layout_versions')
    .select(
      'id,page_key,version,status,schema_version,layout,published_at',
    )
    .eq('page_key', pageKey)
    .eq('status', 'published')
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return res.status(503).json({ error: 'UI_LAYOUT_STORAGE_NOT_READY' });
  }

  return res.json({ version: data ?? null });
});

export default router;
