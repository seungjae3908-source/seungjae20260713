import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertSignalIntelligenceV3Snapshot, SIGNAL_INTELLIGENCE_V3_POLICY } from './engine.mjs';

const HOST = process.env.SIGNAL_INTELLIGENCE_HOST || '127.0.0.1';
const PORT = Number(process.env.SIGNAL_INTELLIGENCE_PORT || 8790);
const SERVICE_SHA = String(process.env.SIGNAL_INTELLIGENCE_SERVICE_SHA || '').trim().toLowerCase();
const STATE_FILE = resolve(process.env.SIGNAL_INTELLIGENCE_STATE_FILE || './state/latest-snapshot.json');
const MAX_STATE_AGE_MS = Number(process.env.SIGNAL_INTELLIGENCE_MAX_STATE_AGE_MS || 15 * 60_000);

if (!/^([0-9a-f]{40})$/.test(SERVICE_SHA)) throw new Error('SIGNAL_INTELLIGENCE_SERVICE_SHA_REQUIRED');
if (HOST !== '127.0.0.1' && HOST !== '::1') throw new Error('SIGNAL_INTELLIGENCE_LOOPBACK_ONLY');
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) throw new Error('SIGNAL_INTELLIGENCE_PORT_INVALID');

let cache = { mtimeMs: -1, snapshot: null, loadedAt: null, error: 'SNAPSHOT_NOT_READY' };

async function loadSnapshot() {
  try {
    const metadata = await stat(STATE_FILE);
    if (cache.snapshot && cache.mtimeMs === metadata.mtimeMs) return cache;
    const parsed = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    assertSignalIntelligenceV3Snapshot(parsed);
    cache = { mtimeMs: metadata.mtimeMs, snapshot: parsed, loadedAt: new Date().toISOString(), error: null };
    return cache;
  } catch (error) {
    cache = {
      mtimeMs: -1,
      snapshot: null,
      loadedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message.split(':')[0] : 'SNAPSHOT_LOAD_FAILED',
    };
    return cache;
  }
}

function json(res, status, body) {
  const payload = Buffer.from(`${JSON.stringify(body)}\n`);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
  });
  res.end(payload);
}

function snapshotAgeMs(snapshot) {
  const generatedAt = Date.parse(snapshot?.generatedAt || '');
  return Number.isFinite(generatedAt) ? Math.max(0, Date.now() - generatedAt) : Number.POSITIVE_INFINITY;
}

function publicList(snapshot, name) {
  const rows = snapshot?.lists?.[name];
  return Array.isArray(rows) ? rows : [];
}

const routes = new Map([
  ['/v1/signals/kr', 'krBuy'],
  ['/v1/signals/us', 'usBuy'],
  ['/v1/signals/spot', 'spotBuy'],
  ['/v1/signals/futures/long', 'futuresLong'],
  ['/v1/signals/futures/short', 'futuresShort'],
]);

const server = createServer(async (req, res) => {
  if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'METHOD_NOT_ALLOWED' });
  const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);

  if (url.pathname === '/health') {
    const state = await loadSnapshot();
    const ageMs = state.snapshot ? snapshotAgeMs(state.snapshot) : null;
    return json(res, 200, {
      ok: true,
      service: 'signal-intelligence-v3',
      serviceSha: SERVICE_SHA,
      policyVersion: SIGNAL_INTELLIGENCE_V3_POLICY.version,
      bindHost: HOST,
      port: PORT,
      snapshotReady: Boolean(state.snapshot),
      snapshotAgeMs: ageMs,
      snapshotFresh: ageMs != null ? ageMs <= MAX_STATE_AGE_MS : false,
      snapshotError: state.error,
      executionAuthority: 'NONE',
      privateTradingApiAllowed: false,
      realOrderAllowed: false,
      liveTrading: false,
    });
  }

  const state = await loadSnapshot();
  if (!state.snapshot) {
    return json(res, 503, {
      ok: false,
      error: state.error || 'SNAPSHOT_NOT_READY',
      executionAuthority: 'NONE',
    });
  }
  const ageMs = snapshotAgeMs(state.snapshot);
  if (ageMs > MAX_STATE_AGE_MS) {
    return json(res, 503, {
      ok: false,
      error: 'SNAPSHOT_STALE',
      generatedAt: state.snapshot.generatedAt,
      ageMs,
      executionAuthority: 'NONE',
    });
  }

  if (url.pathname === '/v1/signals') {
    return json(res, 200, {
      ok: true,
      serviceSha: SERVICE_SHA,
      snapshot: state.snapshot,
      executionAuthority: 'NONE',
    });
  }

  const listName = routes.get(url.pathname);
  if (listName) {
    return json(res, 200, {
      ok: true,
      serviceSha: SERVICE_SHA,
      generatedAt: state.snapshot.generatedAt,
      list: listName,
      candidates: publicList(state.snapshot, listName),
      executionAuthority: 'NONE',
    });
  }

  return json(res, 404, { ok: false, error: 'NOT_FOUND' });
});

server.listen(PORT, HOST, () => {
  process.stdout.write(`${JSON.stringify({
    event: 'signal_intelligence_started',
    serviceSha: SERVICE_SHA,
    host: HOST,
    port: PORT,
    executionAuthority: 'NONE',
    privateTradingApiAllowed: false,
    realOrderAllowed: false,
  })}\n`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
