import { Router, type IRouter, type Response } from 'express';

import { requireCapability, type AuthenticatedRequest } from '../../middleware/auth';
import { PreviewOnlyExecutionProviderAdapter } from './member-investment.provider';
import { createSupabaseMemberInvestmentRepository } from './member-investment.repository';
import { MemberInvestmentService, type AutomationPolicyInput, type OrderIntentInput } from './member-investment.service';
import { MemberInvestmentTelegramService } from './member-investment-telegram.service';

type ServiceContract = Pick<MemberInvestmentService, 'overview' | 'savePolicy' | 'createIntentPreview' | 'listIntents' | 'rejectRealExecution'>;
type ServiceFactory = (accessToken: string, userId: string) => ServiceContract;

function defaultService(accessToken: string, userId: string) {
  return new MemberInvestmentService(
    createSupabaseMemberInvestmentRepository(accessToken, userId),
    new PreviewOnlyExecutionProviderAdapter(),
    new MemberInvestmentTelegramService(),
  );
}

function identity(req: AuthenticatedRequest) {
  if (req.member?.status !== 'approved' || req.member.is_active === false) throw new Error('MEMBER_INACTIVE');
  const userId = req.member?.id?.trim() ?? '';
  const token = req.accessToken?.trim() ?? '';
  if (!userId || !token) throw new Error('LOGIN_REQUIRED');
  const candidate = { ...(req.query as Record<string, unknown>), ...((req.body ?? {}) as Record<string, unknown>) };
  if ('userId' in candidate || 'user_id' in candidate || 'memberId' in candidate || 'member_id' in candidate) {
    throw new Error('FORGED_USER_ID_REJECTED');
  }
  return { userId, token };
}

function statusFor(code: string) {
  if (code === 'LOGIN_REQUIRED') return 401;
  if (code === 'MEMBER_INACTIVE' || code === 'FORGED_USER_ID_REJECTED' || code.includes('OWNER_MISMATCH') || code.includes('USER_SCOPE_MISMATCH')) return 403;
  if (code === 'ACCOUNT_CONNECTION_MISSING') return 404;
  if (code === 'LIVE_ACTIVATION_NOT_APPROVED' || code === 'REAL_ORDER_EXECUTION_DISABLED') return 423;
  if (code.includes('INVALID')) return 400;
  return 503;
}

function fail(res: Response, error: unknown) {
  const code = error instanceof Error ? error.message : 'MEMBER_INVESTMENT_UNAVAILABLE';
  return res.status(statusFor(code)).json({
    ok: false, error: code, executionAuthority: 'NONE', liveTrading: false,
    realOrderAllowed: false, orderSubmitted: false, privateProviderRequests: 0,
  });
}

export function createMemberInvestmentRouter(serviceFactory: ServiceFactory = defaultService): IRouter {
  const router: IRouter = Router();
  router.use(requireCapability('canAccessBasicInfo'));

  router.get('/overview', async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    try { const { userId, token } = identity(req); return res.json({ ok: true, ...(await serviceFactory(token, userId).overview(userId)) }); }
    catch (error) { return fail(res, error); }
  });

  router.get('/intents', requireCapability('canAccessRiskPreview'), async (req: AuthenticatedRequest, res) => {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    try { const { userId, token } = identity(req); return res.json({ ok: true, ...(await serviceFactory(token, userId).listIntents(userId)) }); }
    catch (error) { return fail(res, error); }
  });

  router.put('/policies', requireCapability('canAccessRiskPreview'), async (req: AuthenticatedRequest, res) => {
    try { const { userId, token } = identity(req); return res.json({ ok: true, ...(await serviceFactory(token, userId).savePolicy(userId, req.body as AutomationPolicyInput)) }); }
    catch (error) { return fail(res, error); }
  });

  router.post('/intents/preview', requireCapability('canAccessRiskPreview'), async (req: AuthenticatedRequest, res) => {
    try {
      const { userId, token } = identity(req);
      const result = await serviceFactory(token, userId).createIntentPreview(userId, req.body as OrderIntentInput);
      return res.status(result.duplicate ? 200 : 201).json({ ok: true, ...result });
    } catch (error) { return fail(res, error); }
  });

  for (const action of ['place-order', 'cancel-order', 'amend-order', 'transfer', 'withdraw']) {
    router.post(`/execution/${action}`, requireCapability('canPlaceOrders'), async (req: AuthenticatedRequest, res) => {
      try { const { userId, token } = identity(req); await serviceFactory(token, userId).rejectRealExecution(userId, action); }
      catch (error) { return fail(res, error); }
    });
  }
  return router;
}

export default createMemberInvestmentRouter();
