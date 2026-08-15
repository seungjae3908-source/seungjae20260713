import { Router, type IRouter } from 'express';
import type { AccountProvider } from './account-readonly.contract';
import { AccountReadonlyService } from './account-readonly.service';

const PROVIDERS = new Set<AccountProvider>(['toss', 'upbit', 'bitget']);
export function accountReadFlags(environment: NodeJS.ProcessEnv = process.env) {
  return {
    toss: environment.TOSS_ACCOUNT_READ_ENABLED === 'true',
    upbit: environment.UPBIT_ACCOUNT_READ_ENABLED === 'true',
    bitget: environment.BITGET_ACCOUNT_READ_ENABLED === 'true',
  } as const;
}

export function createAccountReadonlyRouter(service: AccountReadonlyService): IRouter {
  const router: IRouter = Router();
  router.get('/:provider', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const provider = String(req.params.provider ?? '').toLowerCase() as AccountProvider;
    if (!PROVIDERS.has(provider)) return res.status(404).json({ ok: false, errorCode: 'ACCOUNT_PROVIDER_NOT_SUPPORTED', credentialsReturned: false, orderRequests: 0, cancelRequests: 0, amendRequests: 0, transferRequests: 0, withdrawalRequests: 0, liveTradingEnabled: false, autoTradingEnabled: false });
    const controller = new AbortController(); const abort = () => controller.abort(); req.once('aborted', abort);
    try { const snapshot = await service.read(provider, controller.signal); if (!res.writableEnded) return res.json(snapshot); }
    finally { req.removeListener('aborted', abort); }
  });
  return router;
}
