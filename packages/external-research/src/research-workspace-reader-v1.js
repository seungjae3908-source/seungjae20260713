import { buildResearchWorkspace, selectWorkspaceStrategies } from './research-workspace-v1.js';
/** No routes, disk paths, network, schedules or provider calls are created here.
 * Mount only after the existing authentication + capability middleware.
 * loadVideoSnapshot MUST reuse sanitizeVideoResearchRuntimeEvidence.
 * Policy comes from a trusted caller, NEVER a request body or source snapshot.
 */
export function createResearchWorkspaceReader({ authorize, loadVideoSnapshot, loadRegistry, loadPolicy, clock = () => new Date().toISOString() }) {
  if (![authorize, loadVideoSnapshot, loadRegistry, loadPolicy, clock].every(fn => typeof fn === 'function')) throw new Error('EXPLICIT_READER_DEPENDENCIES_REQUIRED');
  return async function read(req, res) {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Vary', 'Authorization, Cookie');
    // Guard methods before data access, even when the surrounding router changes.
    if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); res.status(405).json({ error: 'READ_ONLY' }); return; }
    let allowed = false;
    try { allowed = await authorize(req) === true; } catch { /* Fail closed. */ }
    if (!allowed) { res.status(403).json({ error: 'RESEARCH_ACCESS_REQUIRED' }); return; }
    const group = req.query?.group ?? 'ALL', market = req.query?.market ?? 'ALL';
    try { selectWorkspaceStrategies({ strategies: [] }, group, market); }
    catch { res.status(400).json({ error: 'FILTER_INVALID' }); return; }
    // Reads are intentionally sequential: an invalid source policy avoids registry I/O.
    let trust;
    try { trust = await loadPolicy(); } catch { res.status(200).json({ available: false, reason: 'TRUST_POLICY_UNAVAILABLE' }); return; }
    if (!trust || typeof trust !== 'object') { res.status(200).json({ available: false, reason: 'TRUST_POLICY_MISSING' }); return; }
    let video;
    try { video = await loadVideoSnapshot(); }
    catch { res.status(200).json({ available: false, reason: 'VIDEO_SNAPSHOT_UNAVAILABLE' }); return; }
    const policy = { now: clock(), expectedSourceHeadSha: trust.expectedSourceHeadSha, maxAgeMs: trust.maxAgeMs };
    const source = buildResearchWorkspace({ videoEvidence: video, policy });
    if (source.sourceState !== 'MEASURED') { res.status(200).json({ available: true, workspace: source }); return; }
    let registry;
    try { registry = await loadRegistry(); }
    catch { res.status(200).json({ available: true, workspace: { ...source, registryState: 'UNAVAILABLE', registryReason: 'REGISTRY_READ_FAILED' } }); return; }
    const view = buildResearchWorkspace({ videoEvidence: video, registry: registry ?? null, policy });
    res.status(200).json({ available: true, workspace: { ...view, strategies: selectWorkspaceStrategies(view, group, market), filter: { group, market } } });
  };
}
