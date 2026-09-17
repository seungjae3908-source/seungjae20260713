import { Router, type IRouter } from 'express';
import { requireAdmin, type AuthenticatedRequest } from '../middleware/auth';
import { ProductPaperSourceError, productPaperSourceRegistry, type ProductPaperSourceRegistry } from '../services/product-paper-source-registry.service';

const MAX_REQUEST_BYTES = 16 * 1024;
export function createScannerPaperPlansRouter(dependencies: {
  registry?: ProductPaperSourceRegistry; sourceSha?: () => string;
} = {}): IRouter {
  const router: IRouter = Router();
  const registry = dependencies.registry ?? productPaperSourceRegistry;
  const sourceSha = dependencies.sourceSha ?? (() => String(process.env.DEPLOY_SHA ?? '').trim().toLowerCase());
  router.post('/scanner/plans', requireAdmin, (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const safety = { accountMode: 'PAPER', executionAuthority: 'NONE', liveOrderEnabled: false,
      privateTradingApiAllowed: false, orderSubmitted: false, exchangeRequestSent: false, evidenceCredit: 0 };
    let length: number;
    try { length = Buffer.byteLength(JSON.stringify(req.body ?? null), 'utf8'); }
    catch { length = MAX_REQUEST_BYTES + 1; }
    if (length > MAX_REQUEST_BYTES) return res.status(413).json({ ok: false, error: 'REQUEST_TOO_LARGE', ...safety });
    try {
      const resolved = registry.resolveScanner(req.member!.id, req.body, sourceSha());
      // Real source comparison is now connected. Admission/execution is NOT:
      // no generic trade plan, repository write or fake Paper fill fallback.
      return res.status(503).json({ ok: false, error: 'CANONICAL_PAPER_EXECUTION_CONSUMER_NOT_CONNECTED',
        stage: 'SERVER_SOURCE_IDENTITY_VALIDATED', serverVerified: true, executionConnected: false,
        paperCandidate: resolved.paperCandidate, originalSignalDirection: resolved.originalSignalDirection, ...safety });
    } catch (error) {
      const sourceError = error instanceof ProductPaperSourceError ? error : null;
      return res.status(sourceError?.status ?? 400).json({ ok: false,
        error: sourceError?.code ?? (error instanceof Error ? error.message : 'SCANNER_PAPER_SOURCE_INVALID'), ...safety });
    }
  });
  return router;
}
