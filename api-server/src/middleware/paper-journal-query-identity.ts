import type { NextFunction, Request, Response } from 'express';

export function rejectPaperJournalQueryIdentity(
  request: Request,
  response: Response,
  next: NextFunction,
) {
  if (!('userId' in request.query) && !('user_id' in request.query)) {
    return next();
  }

  return response.status(400).json({
    mode: 'journal-sync-only',
    orderSubmitted: false,
    exchangeRequestSent: false,
    ok: false,
    code: 'CLIENT_USER_ID_FORBIDDEN',
    message: '사용자 ID는 로그인 세션에서만 결정됩니다.',
  });
}
