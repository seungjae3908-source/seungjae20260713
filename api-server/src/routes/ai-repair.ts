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
  return [
    '현재 주식 앱을 읽기 전용으로 진단해 주세요.',
    '',
    `진단 대상: ${request || '프론트엔드·백엔드·API·배포 상태 전체'}`,
    '',
    '필수 규칙:',
    '1. 소스 수정, 배포, 서버 재시작, 데이터 삭제를 실행하지 마세요.',
    '2. 키움·비트겟 실제 주문, 정정, 취소, 자동매매를 절대 실행하지 마세요.',
    '3. KIWOOM_MODE와 실주문 환경변수를 변경하지 마세요.',
    '4. 비밀키와 토큰은 출력하지 말고 마스킹하세요.',
    '5. TypeScript 검사, 빌드 검사, API 상태와 최근 오류 로그를 확인하세요.',
    '6. 확인된 오류와 추정 원인을 구분하세요.',
    '',
    '결과 형식:',
    '- 발견된 오류 수',
    '- 오류별 파일 경로와 위치',
    '- 재현 방법',
    '- 확인된 원인',
    '- 안전한 수정 방법',
    '- 수정 우선순위',
    '- 추가 확인 항목',
  ].join('\n');
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
    '다음 오류가 발견되었습니다. 원인을 확인하고 안전하게 수정해 주세요.',
    '',
    `요청사항: ${request || job?.request || '아래 오류를 안전하게 수정'}`,
    job ? `진단 작업 번호: ${job.id}` : '',
    job ? `진단 상태: ${job.status}` : '',
    '',
    '발견된 오류:',
    job
      ? collectJobErrors(job)
      : '연결된 진단 작업이 없습니다. 먼저 오류 로그를 확인하세요.',
    '',
    '필수 안전 규칙:',
    '1. 작업 전 현재 상태를 백업하고 복구 지점을 만드세요.',
    '2. 운영 서버를 직접 수정하지 말고 격리 작업공간에서 수정하세요.',
    '3. 키움·비트겟 실제 주문, 정정, 취소, 자동매매를 절대 실행하지 마세요.',
    '4. KIWOOM_MODE, 실주문 환경변수, X-Auto-Trade-Key를 변경하거나 사용하지 마세요.',
    '5. 비밀키와 토큰을 출력하거나 코드에 저장하지 마세요.',
    '6. 관련 파일만 최소 범위로 수정하세요.',
    '7. 프론트·백엔드 TypeScript 검사와 프로덕션 빌드를 실행하세요.',
    '8. 검사 실패 시 운영 적용을 중단하세요.',
    '9. 변경 파일, 검사 결과, 복구 방법을 보여주고 운영 적용 승인을 기다리세요.',
    '10. 승인 후 백업을 만든 다음 적용하고 실패하면 즉시 이전 버전으로 복구하세요.',
    '',
    '보고 형식:',
    '- 확인된 원인',
    '- 수정한 파일과 내용',
    '- 실행한 검사와 결과',
    '- 남아 있는 위험',
    '- 운영 적용 방법',
    '- 이전 작업으로 돌아가기 방법',
  ].filter(Boolean).join('\n');
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
