import { createHash } from 'node:crypto';
import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { getUserSupabase } from '../lib/supabase';

const router: IRouter = Router();

const ALLOWED_KEYS = new Set([
  'knowledge-info-asset-mode-v1',
  'sa-settings-v1',
  'stock-currency-mode',
  'app-accent-color',
  'app-appearance-mode',
  'seungjae_watchlist_v1',
  'scanner.threshold.v1',
  'scanner-market',
  'sa-auto-trade-settings-v1',
  'sa-portfolio-chart-overlays-v1',
  'sa-portfolio-purchase-dates-v1',
  'sa-chart-volume-height-v1',
  'sa-chart-frames-v1',
  'sa-chart-ma-v1',
]);

const MAX_BACKUP_BYTES = 5 * 1024 * 1024;
const MAX_ITEMS = 500;
const MAX_VALUE_BYTES = 1024 * 1024;

function normalizePayload(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('INVALID_BACKUP_PAYLOAD');
  }

  const result: Record<string, string> = {};
  const entries = Object.entries(value);
  if (entries.length > MAX_ITEMS) throw new Error('BACKUP_ITEM_LIMIT_EXCEEDED');

  for (const [key, item] of entries) {
    if (!ALLOWED_KEYS.has(key) || typeof item !== 'string') continue;
    if (Buffer.byteLength(item, 'utf8') > MAX_VALUE_BYTES) {
      throw new Error('BACKUP_VALUE_TOO_LARGE');
    }
    result[key] = item;
  }

  const encoded = JSON.stringify(result);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BACKUP_BYTES) {
    throw new Error('BACKUP_TOO_LARGE');
  }
  return result;
}

function checksum(payload: Record<string, string>): string {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

router.get('/latest', async (req: AuthenticatedRequest, res) => {
  if (!req.member || !req.accessToken) return res.status(401).json({ error: 'LOGIN_REQUIRED' });

  try {
    const supabase = getUserSupabase(req.accessToken);
    const { data, error } = await supabase
      .from('app_backups')
      .select('schema_version,payload,item_count,checksum,client_updated_at,updated_at')
      .eq('member_id', req.member.id)
      .maybeSingle();

    if (error) throw error;
    if (!data) return res.json({ ok: true, exists: false });

    return res.json({
      ok: true,
      exists: true,
      schemaVersion: data.schema_version,
      localStorage: normalizePayload(data.payload),
      itemCount: data.item_count,
      checksum: data.checksum,
      clientUpdatedAt: data.client_updated_at,
      updatedAt: data.updated_at,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'BACKUP_READ_FAILED';
    return res.status(503).json({ error: 'BACKUP_READ_FAILED', detail: message });
  }
});

router.put('/latest', async (req: AuthenticatedRequest, res) => {
  if (!req.member || !req.accessToken) return res.status(401).json({ error: 'LOGIN_REQUIRED' });

  try {
    const schemaVersion = Number(req.body?.schemaVersion ?? 1);
    if (!Number.isInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > 20) {
      return res.status(400).json({ error: 'INVALID_BACKUP_VERSION' });
    }

    const payload = normalizePayload(req.body?.localStorage);
    const clientUpdatedAt = req.body?.clientUpdatedAt
      ? new Date(String(req.body.clientUpdatedAt)).toISOString()
      : new Date().toISOString();
    const digest = checksum(payload);
    const supabase = getUserSupabase(req.accessToken);
    const { data, error } = await supabase
      .from('app_backups')
      .upsert(
        {
          member_id: req.member.id,
          schema_version: schemaVersion,
          payload,
          item_count: Object.keys(payload).length,
          checksum: digest,
          client_updated_at: clientUpdatedAt,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'member_id' },
      )
      .select('schema_version,item_count,checksum,client_updated_at,updated_at')
      .single();

    if (error) throw error;
    return res.json({
      ok: true,
      exists: true,
      schemaVersion: data.schema_version,
      itemCount: data.item_count,
      checksum: data.checksum,
      clientUpdatedAt: data.client_updated_at,
      updatedAt: data.updated_at,
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'BACKUP_SAVE_FAILED';
    const status = message.startsWith('BACKUP_') || message.startsWith('INVALID_') ? 400 : 503;
    return res.status(status).json({ error: message, detail: message });
  }
});

export default router;
