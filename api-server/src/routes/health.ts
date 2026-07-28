import { Router, type IRouter } from 'express';
import { HealthCheckResponse } from '@workspace/api-zod';
import { getApiResilienceSnapshot } from '../lib/api-resilience';

const router: IRouter = Router();
const startedAt = new Date().toISOString();

router.get('/healthz', (_req, res) => {
  const data = HealthCheckResponse.parse({ status: 'ok' });
  res.json(data);
});

// 프로세스가 살아 있는지만 빠르게 확인합니다.
router.get('/live', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.json({
    ok: true,
    status: 'live',
    service: 'api-server',
    startedAt,
    uptimeSeconds: Math.floor(process.uptime()),
    checkedAt: new Date().toISOString(),
  });
});

// 요청을 받을 준비가 되었는지와 현재 저하 상태를 구분합니다.
router.get('/ready', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const resilience = getApiResilienceSnapshot();
  const degradedProviders = resilience.providers
    .filter((item) => item.circuit.state === 'open')
    .map((item) => item.provider);
  const memory = process.memoryUsage();

  res.json({
    ok: true,
    status: degradedProviders.length > 0 ? 'degraded' : 'ready',
    service: 'api-server',
    degradedProviders,
    cacheEntries: resilience.cacheEntries,
    inflightRequests: resilience.inflightRequests,
    memory: {
      rssMb: Math.round(memory.rss / 1024 / 1024),
      heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(memory.heapTotal / 1024 / 1024),
    },
    realtimeChartEnabled:
      String(process.env.REALTIME_CHART_ENABLED ?? 'false').toLowerCase() === 'true',
    checkedAt: new Date().toISOString(),
  });
});

// 공개 상태 조회에는 내부 오류문과 스택을 노출하지 않습니다.
router.get('/provider-health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, max-age=0');

  const snapshot = getApiResilienceSnapshot();
  res.json({
    ok: true,
    cacheEntries: snapshot.cacheEntries,
    inflightRequests: snapshot.inflightRequests,
    providers: snapshot.providers.map((item) => ({
      provider: item.provider,
      status: item.circuit.state === 'open' ? 'degraded' : 'ok',
      failures: item.circuit.failures,
      calls: item.stats.calls,
      successes: item.stats.successes,
      cacheHits: item.stats.cacheHits,
      staleHits: item.stats.staleHits,
      lastLatencyMs: item.stats.lastLatencyMs,
      lastSuccessAt: item.stats.lastSuccessAt,
      lastFailureAt: item.stats.lastFailureAt,
    })),
    checkedAt: new Date().toISOString(),
  });
});

export default router;
