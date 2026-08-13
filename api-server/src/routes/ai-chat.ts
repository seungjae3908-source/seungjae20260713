import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../middleware/auth';
import { AiChatError, answerAiChat, type AiChatContext } from '../services/ai-chat.service';
import { answerPortfolioMentor } from '../services/portfolio-mentor-ai.service';
import { buildPortfolioIntelligence } from '../services/portfolio-intelligence.service';
import type { PortfolioMentorMessage } from '../modules/portfolio/mentor-v2';

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

function conversationFromBody(value: unknown): PortfolioMentorMessage[] {
  if (!Array.isArray(value)) return [];
  return value.slice(-20).flatMap((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (row.role !== 'user' && row.role !== 'assistant') return [];
    if (typeof row.content !== 'string' || !row.content.trim()) return [];
    return [{ role: row.role, content: row.content, createdAt: typeof row.createdAt === 'string' ? row.createdAt : null }];
  });
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
    const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
      ? req.body as Record<string, unknown>
      : {};
    if (body.mentorMode === 'portfolio') {
      if (!req.accessToken) return res.status(401).json({ ok: false, error: 'LOGIN_REQUIRED' });
      const contextStartedAt = performance.now();
      const portfolio = await buildPortfolioIntelligence({ accessToken: req.accessToken, profile: body.allocationProfile });
      const contextLatencyMs = Math.round((performance.now() - contextStartedAt) * 10) / 10;
      const result = await answerPortfolioMentor({
        message: body.message,
        portfolio,
        conversation: conversationFromBody(body.conversation),
        selectedContext: body.context as AiChatContext | undefined,
        signal: controller.signal,
      });
      return res.json({ ok: true, ...result, mentorMode: 'portfolio', contextLatencyMs });
    }
    return res.json({ ok: true, ...(await answerAiChat(body, fetch, controller.signal)) });
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
