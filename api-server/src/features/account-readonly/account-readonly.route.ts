import { Router, type IRouter } from 'express';
import type { AuthenticatedRequest } from '../../middleware/auth';
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

function deniedResponse(errorCode: string) {
  return {
    ok: false,
    errorCode,
    credentialsReturned: false,
    orderRequests: 0,
    cancelRequests: 0,
    amendRequests: 0,
    transferRequests: 0,
    withdrawalRequests: 0,
    liveTradingEnabled: false,
    autoTradingEnabled: false,
  } as const;
}

export function createAccountReadonlyRouter(service: AccountReadonlyService): IRouter {
  const router: IRouter = Router();
  router.get('/:provider', async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    const provider = String(req.params.provider ?? '').toLowerCase() as AccountProvider;
    if (!PROVIDERS.has(provider)) {
      return res.status(404).json(deniedResponse('ACCOUNT_PROVIDER_NOT_SUPPORTED'));
    }

    const userId = req.member?.id ?? '';
    const accessToken = req.accessToken ?? '';
    if (!userId || !accessToken) {
      return res.status(401).json(deniedResponse('LOGIN_REQUIRED'));
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort);
    try {
      const snapshot = await service.read({ userId, accessToken }, provider, controller.signal);
      if (!res.writableEnded) return res.json(snapshot);
    } finally {
      req.removeListener('aborted', abort);
    }
  });
  return router;
}
