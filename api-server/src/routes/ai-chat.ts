import { Router, type IRouter, type RequestHandler } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { requireCapability } from '../middleware/auth';
import { AiChatError, answerAiChat } from '../services/ai-chat.service';
import {
  generateStructuredFeatureExplanation,
  type AiFeatureTask,
} from '../services/ai-feature-explanation.service';

const router: IRouter = Router();
const userBuckets = new Map<string, { count: number; resetAt: number }>();

function acceptUserRequest(userId: string, now = Date.now()): boolean {
  for (const [key, bucket] of userBuckets) {
    if (bucket.resetAt <= now) userBuckets.delete(key);
  }
  const bucket = userBuckets.get(userId);
  if (!bucket || bucket.resetAt <= now) {
    userBuckets.set(userId, { count: 1, resetAt: now + 60_000 });
    return true;
  }
  bucket.count += 1;
  return bucket.count <= 20;
}

function featureRequest(task: AiFeatureTask, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', '구조화 AI 기능 설명 요청 형식이 올바르지 않습니다.', 400);
  }
  const row = value as Record<string, unknown>;
  const allowed = new Set(['taskVersion', 'sourceVersion', 'payload']);
  if (Object.keys(row).some((key) => !allowed.has(key))) {
    throw new AiChatError('AI_FEATURE_INVALID_INPUT', '허용되지 않은 구조화 AI 라우트 필드가 포함되어 있습니다.', 400);
  }
  return {
    task,
    taskVersion: row.taskVersion,
    sourceVersion: row.sourceVersion,
    payload: row.payload,
  };
}

function featureExplanationHandler(task: AiFeatureTask): RequestHandler {
  return async (request, res) => {
    const req = request as AuthenticatedRequest;
    if (!req.member || !acceptUserRequest(req.member.id)) {
      return res.status(req.member ? 429 : 401).json({
        ok: false,
        error: req.member ? 'AI_FEATURE_RATE_LIMITED' : 'LOGIN_REQUIRED',
        message: req.member ? 'AI 기능 설명 요청이 많습니다. 잠시 후 다시 시도해 주세요.' : '로그인이 필요합니다.',
        advisoryOnly: true,
        mutationPerformed: false,
        orderRequestSent: false,
      });
    }

    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once('close', onClose);
    res.setHeader('Cache-Control', 'no-store, max-age=0');

    try {
      const result = await generateStructuredFeatureExplanation(
        featureRequest(task, req.body ?? {}),
        { externalSignal: controller.signal },
      );
      return res.json({
        ok: true,
        inputAuthority: 'validated-client-snapshot',
        authoritativeStateUsed: false,
        mutationPerformed: false,
        orderRequestSent: false,
        ...result,
      });
    } catch (cause) {
      const error = cause instanceof AiChatError
        ? cause
        : new AiChatError('AI_FEATURE_FAILED', '구조화 AI 기능 설명 요청을 처리하지 못했습니다.', 500);
      return res.status(error.statusCode).json({
        ok: false,
        error: error.code,
        message: error.message,
        advisoryOnly: true,
        mutationPerformed: false,
        orderRequestSent: false,
      });
    } finally {
      res.off('close', onClose);
    }
  };
}

router.post('/ai/chat', async (req: AuthenticatedRequest, res) => {
  if (!req.member || !acceptUserRequest(req.member.id)) {
    return res.status(req.member ? 429 : 401).json({
      ok: false,
      error: req.member ? 'AI_CHAT_RATE_LIMITED' : 'LOGIN_REQUIRED',
      message: req.member ? 'AI 채팅 요청이 많습니다. 잠시 후 다시 시도해 주세요.' : '로그인이 필요합니다.',
    });
  }
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once('close', onClose);
  try {
    return res.json({ ok: true, ...(await answerAiChat(req.body ?? {}, fetch, controller.signal)) });
  } catch (cause) {
    const error = cause instanceof AiChatError
      ? cause
      : new AiChatError('AI_CHAT_FAILED', 'AI 채팅 요청을 처리하지 못했습니다.', 500);
    return res.status(error.statusCode).json({ ok: false, error: error.code, message: error.message });
  } finally {
    res.off('close', onClose);
  }
});

router.post(
  '/ai/features/chart/explanation',
  requireCapability('canAccessBasicInfo'),
  featureExplanationHandler('chart_analysis_explanation'),
);
router.post(
  '/ai/features/scanner/explanation',
  requireCapability('canAccessBasicInfo'),
  featureExplanationHandler('scanner_signal_explanation'),
);
router.post(
  '/ai/features/trade-plan/explanation',
  requireCapability('canAccessPaperTrading'),
  featureExplanationHandler('trade_plan_risk_explanation'),
);

export default router;
