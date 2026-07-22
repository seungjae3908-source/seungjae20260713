// AI_REPAIR_COST_CONSENT_V1
// AI_REPAIR_HISTORY_SETTINGS_V1
import { Router, type Response } from 'express';
import { requireAdmin, requireMember, type AuthenticatedRequest } from '../middleware/auth';
import {
  approveAiRepairCost,
  approveAiRepairJob,
  cancelAiRepairJob,
  createAiRepairJob,
  estimateAiRepairCost,
  getAiRepairConfig,
  getAiRepairCostHistoryPage,
  getAiRepairCostSummary,
  getAiRepairFeatureSettings,
  getAiRepairJob,
  listAiRepairJobsPage,
  updateAiRepairFeatureSettings,
} from '../services/ai-repair.service';
import type { AiRepairJobKind } from '../types/ai-repair';

const router = Router();

router.use(requireMember, requireAdmin);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'AI 복구 요청 처리 중 오류가 발생했습니다.';
}

function fail(res: Response, error: unknown, status = 400): void {
  res.status(status).json({
    ok: false,
    error: 'AI_REPAIR_REQUEST_FAILED',
    message: errorMessage(error),
  });
}

router.get('/config', (_req, res) => {
  try {
    res.json({ ok: true, config: getAiRepairConfig() });
  } catch (error) {
    fail(res, error, 500);
  }
});



router.get('/settings', (_req, res) => {
  try {
    res.json({
      ok: true,
      settings: getAiRepairFeatureSettings(),
    });
  } catch (error) {
    fail(res, error, 500);
  }
});

router.patch('/settings', (req, res) => {
  try {
    const settings = updateAiRepairFeatureSettings({
      freeDiagnosisEnabled:
        typeof req.body?.freeDiagnosisEnabled === 'boolean'
          ? req.body.freeDiagnosisEnabled
          : undefined,
      paidDiagnosisEnabled:
        typeof req.body?.paidDiagnosisEnabled === 'boolean'
          ? req.body.paidDiagnosisEnabled
          : undefined,
      improvementEnabled:
        typeof req.body?.improvementEnabled === 'boolean'
          ? req.body.improvementEnabled
          : undefined,
    });

    res.json({ ok: true, settings });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/costs', (req, res) => {
  try {
    const month = String(req.query.month ?? '').trim();
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(req.query.pageSize ?? 10);

    const history = getAiRepairCostHistoryPage(
      page,
      pageSize,
    );

    res.json({
      ok: true,
      summary: getAiRepairCostSummary(month || undefined),
      history: history.items,
      pagination: history.pagination,
    });
  } catch (error) {
    fail(res, error, 500);
  }
});

router.post('/estimate', (req, res) => {
  try {
    const kind = String(
      req.body?.kind ?? 'diagnosis',
    ) as AiRepairJobKind;

    if (kind !== 'diagnosis' && kind !== 'improvement') {
      throw new Error('지원하지 않는 작업 종류입니다.');
    }

    const request = String(req.body?.request ?? '')
      .trim()
      .slice(0, 4_000);

    const jobId =
      String(req.body?.jobId ?? '').trim() || undefined;

    const estimate = estimateAiRepairCost({
      kind,
      request,
      jobId,
      paid: req.body?.paid === true,
    });

    res.json({ ok: true, estimate });
  } catch (error) {
    fail(res, error);
  }
});

router.get('/jobs', (req, res) => {
  try {
    const page = Number(req.query.page ?? 1);
    const pageSize = Number(
      req.query.pageSize ??
      req.query.limit ??
      10,
    );

    const result = listAiRepairJobsPage(
      page,
      pageSize,
    );

    res.json({
      ok: true,
      jobs: result.jobs,
      pagination: result.pagination,
      activeCount: result.activeCount,
    });
  } catch (error) {
    fail(res, error, 500);
  }
});

router.get('/jobs/:id', (req, res) => {
  try {
    res.json({ ok: true, job: getAiRepairJob(String(req.params.id)) });
  } catch (error) {
    fail(res, error, 404);
  }
});

router.post('/jobs', (req: AuthenticatedRequest, res) => {
  try {
    const kind = String(req.body?.kind ?? 'diagnosis') as AiRepairJobKind;
    const request = String(req.body?.request ?? '').trim();
    if (kind !== 'diagnosis' && kind !== 'improvement') {
      throw new Error('지원하지 않는 작업 종류입니다.');
    }
    if (kind === 'improvement' && request.length < 4) {
      throw new Error('개선 요청을 네 글자 이상 입력해 주세요.');
    }
    if (request.length > 4_000) {
      throw new Error('개선 요청은 4,000자 이하로 입력해 주세요.');
    }

    const job = createAiRepairJob({
      kind,
      request,
      createdBy: req.member?.id ?? '',
      costConsent: req.body?.costConsent === true,
      paidDiagnosis: req.body?.paidDiagnosis === true,
    });
    res.status(202).json({ ok: true, job });
  } catch (error) {
    fail(res, error);
  }
});


router.post('/jobs/:id/approve-ai', (req: AuthenticatedRequest, res) => {
  try {
    const job = approveAiRepairCost(
      String(req.params.id),
      req.body?.costConsent === true,
      req.member?.id ?? '',
    );

    res.status(202).json({ ok: true, job });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/jobs/:id/approve', (req: AuthenticatedRequest, res) => {
  try {
    const phrase = String(req.body?.approvalPhrase ?? '').trim();
    const job = approveAiRepairJob(String(req.params.id), phrase, req.member?.id ?? '');
    res.status(202).json({ ok: true, job });
  } catch (error) {
    fail(res, error);
  }
});

router.post('/jobs/:id/cancel', (req: AuthenticatedRequest, res) => {
  try {
    const job = cancelAiRepairJob(String(req.params.id), req.member?.id ?? '');
    res.status(202).json({ ok: true, job });
  } catch (error) {
    fail(res, error);
  }
});

export default router;
