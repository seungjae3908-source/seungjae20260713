import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { AiChatError, answerAiChat } from '../services/ai-chat.service';

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

export default router;
