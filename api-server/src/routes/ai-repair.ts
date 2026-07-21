import { Router, type Response } from 'express';
import { requireAdmin, requireMember, type AuthenticatedRequest } from '../middleware/auth';
import {
  approveAiRepairJob,
  cancelAiRepairJob,
  createAiRepairJob,
  getAiRepairConfig,
  getAiRepairJob,
  listAiRepairJobs,
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

router.get('/jobs', (req, res) => {
  try {
    const requested = Number(req.query.limit ?? 30);
    const limit = Number.isFinite(requested) ? Math.max(1, Math.min(100, Math.floor(requested))) : 30;
    res.json({ ok: true, jobs: listAiRepairJobs(limit) });
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
    });
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
