// AI_REPAIR_COMMAND_MODES_V2
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
import type { AiRepairJob, AiRepairJobKind } from '../types/ai-repair';

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


function cleanCommandText(value: unknown, max = 24_000): string {
  return String(value ?? '')
    .replace(/\u001b\[[0-9;]*m/g, '')
    .replace(/sk-[A-Za-z0-9_-]{10,}/g, '[OPENAI_KEY_REDACTED]')
    .replace(/github_pat_[A-Za-z0-9_]{10,}/g, '[GITHUB_TOKEN_REDACTED]')
    .slice(0, max)
    .trim();
}

function buildDiagnosisCommand(request: string): string {
  return `요청 내용: ${request}`;
}

function collectJobErrors(job: AiRepairJob): string {
  const diagnostics = (job.diagnosticErrors ?? []).map((item, index) =>
    [
      `[오류 ${index + 1}] ${item.label}`,
      `검사: ${item.name}`,
      cleanCommandText(item.output, 8_000) || '오류 출력 없음',
    ].join('\n'),
  );

  if (diagnostics.length > 0) {
    return diagnostics.join('\n\n');
  }

  const failedChecks = job.checks
    .filter((item) => !item.ok)
    .map((item, index) =>
      [
        `[오류 ${index + 1}] ${item.label}`,
        `검사: ${item.name}`,
        cleanCommandText(item.output, 8_000) || '오류 출력 없음',
      ].join('\n'),
    );

  return failedChecks.join('\n\n') || '저장된 상세 오류 로그가 없습니다.';
}

function buildRepairCommand(
  request: string,
  job?: AiRepairJob,
): string {
  return [
    '발견 된 오류:',
    job
      ? collectJobErrors(job)
      : '발견된 오류 내용이 없습니다.',
    '',
    '개선 할 내용:',
    request || job?.request || '',
  ].join('\n');
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


router.post('/command', (req, res) => {
  try {
    const mode = String(req.body?.mode ?? '').trim();
    const request = cleanCommandText(req.body?.request, 4_000);
    const jobId = cleanCommandText(req.body?.jobId, 200);

    if (mode !== 'diagnosis' && mode !== 'repair') {
      throw new Error(
        '명령어 종류는 diagnosis 또는 repair만 사용할 수 있습니다.',
      );
    }

    const job = jobId ? getAiRepairJob(jobId) : undefined;

    const command =
      mode === 'diagnosis'
        ? buildDiagnosisCommand(request)
        : buildRepairCommand(request, job);

    res.json({
      ok: true,
      mode,
      command,
      jobId: job?.id ?? null,
      aiApiCalled: false,
      estimatedCostUsd: 0,
    });
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
