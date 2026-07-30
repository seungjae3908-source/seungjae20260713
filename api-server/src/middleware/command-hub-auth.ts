import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

function extractProvidedToken(req: Request): string {
  const authorization = req.header('authorization')?.trim();

  if (authorization?.toLowerCase().startsWith('bearer ')) {
    return authorization.slice(7).trim();
  }

  return req.header('x-command-hub-token')?.trim() ?? '';
}

function safeTokenEquals(expected: string, provided: string): boolean {
  const expectedBuffer = Buffer.from(expected, 'utf-8');
  const providedBuffer = Buffer.from(provided, 'utf-8');

  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, providedBuffer);
}

export function requireCommandHubToken(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const expectedToken = process.env.COMMAND_HUB_TOKEN?.trim() ?? '';

  if (expectedToken.length < 32) {
    res.status(503).json({
      ok: false,
      error: 'COMMAND_HUB_NOT_CONFIGURED',
      message:
        'COMMAND_HUB_TOKEN must be configured with at least 32 characters.',
    });
    return;
  }

  const providedToken = extractProvidedToken(req);

  if (!providedToken || !safeTokenEquals(expectedToken, providedToken)) {
    res.status(401).json({
      ok: false,
      error: 'COMMAND_HUB_UNAUTHORIZED',
    });
    return;
  }

  next();
}
