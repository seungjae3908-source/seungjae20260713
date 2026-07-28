import { Router, type IRouter } from 'express';

const router: IRouter = Router();

function getConfig() {
  const repoPath = process.env.AI_REPAIR_REPO_PATH?.trim() || null;
  const enabled = process.env.AI_REPAIR_ENABLED === 'true';
  const aiConfigured = Boolean(process.env.OPENAI_API_KEY?.trim());
  const repositoryReady = Boolean(repoPath);
  const deploymentReady =
    enabled &&
    repositoryReady &&
    process.env.AI_REPAIR_DEPLOYMENT_READY === 'true';

  return {
    enabled,
    aiConfigured,
    repositoryReady,
    deploymentReady,
    repoPath,
    baseBranch:
      process.env.AI_REPAIR_BASE_BRANCH?.trim() ||
      'feature/detail-realtime-chart-integration',
    maxAttempts: Math.max(
      1,
      Math.min(10, Number(process.env.AI_REPAIR_MAX_ATTEMPTS ?? 3) || 3),
    ),
    features: {
      freeDiagnosisEnabled: enabled && repositoryReady,
      paidDiagnosisEnabled: enabled && repositoryReady && aiConfigured,
      improvementEnabled: enabled && repositoryReady && aiConfigured,
      updatedAt: new Date().toISOString(),
    },
    checks: [],
    healthUrl: process.env.AI_REPAIR_HEALTH_URL?.trim() || null,
  };
}

// Replit/일반 API 서버에는 실제 AI 복구 작업 실행기가 없을 수 있습니다.
// 이 경우 404나 가짜 작업을 반환하지 않고 비활성 상태를 명시합니다.
router.get('/config', (_req, res) => {
  res.json({ ok: true, config: getConfig() });
});

router.get('/jobs', (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1) || 1);
  const pageSize = Math.max(
    1,
    Math.min(100, Number(req.query.pageSize ?? 10) || 10),
  );

  res.json({
    ok: true,
    jobs: [],
    pagination: {
      page,
      pageSize,
      total: 0,
      totalPages: 1,
    },
    activeCount: 0,
  });
});

router.get('/costs', (_req, res) => {
  const month = new Date().toISOString().slice(0, 7);
  res.json({
    ok: true,
    summary: {
      month,
      currency: 'USD',
      estimatedCostUsd: 0,
      calls: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      modelRates: {
        model: 'not-configured',
        inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0,
        outputUsdPerMillion: 0,
      },
    },
  });
});

router.use((_req, res) => {
  res.status(503).json({
    ok: false,
    error: 'AI_REPAIR_UNAVAILABLE',
    message:
      '이 서버에는 AI 복구 작업 실행기가 연결되어 있지 않습니다. 설정된 작업 서버에서만 실행할 수 있습니다.',
  });
});

export default router;
