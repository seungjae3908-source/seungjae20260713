import { Router, type IRouter } from 'express';
import {
  evaluateFormulaAiAutoRehearsal,
  FORMULA_AI_REHEARSAL_POLICY_VERSION,
  runFormulaAiPaperRehearsalProbe,
} from '../services/formula-ai-auto-rehearsal.service';
import { FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION } from '../services/formula-ai-live-exception.service';

const router: IRouter = Router();

function enabled() {
  return process.env.APP_ENV === 'staging'
    && process.env.PR_REHEARSAL_PREVIEW_ENABLED === 'true';
}

router.post('/preview/auto-rehearsal/run', (request, response) => {
  if (!enabled()) {
    return response.status(404).json({
      ok: false,
      error: 'PR_REHEARSAL_PREVIEW_DISABLED',
    });
  }

  if (request.body?.confirmed !== true) {
    return response.status(400).json({
      ok: false,
      error: 'REHEARSAL_CONFIRMATION_REQUIRED',
    });
  }

  const paper = runFormulaAiPaperRehearsalProbe(new Date());
  const common = {
    deterministicRuleReady: true,
    aiDecision: 'PASS' as const,
    providersReady: true,
    credentialReuseReady: true,
    paperAutoReady: paper.paperAutoReady,
    paperFillReady: paper.paperFillReady,
    journalReady: paper.journalReady,
    telegramReady: true,
  };

  const inputs = [
    { strategyId: 'KR_PRESSURE_BREAKOUT_V1', market: 'KR_STOCK', direction: 'BUY' },
    { strategyId: 'US_STOCKS_IN_PLAY_ORB_RETEST_V1', market: 'US_STOCK', direction: 'BUY' },
    { strategyId: 'CRYPTO_SPOT_ORDER_FLOW_ML_LONG_V1', market: 'CRYPTO_SPOT', direction: 'BUY' },
    { strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', market: 'CRYPTO_FUTURES', direction: 'LONG' },
    { strategyId: 'CRYPTO_FUTURES_FLOW_TREND_WAVE_V1', market: 'CRYPTO_FUTURES', direction: 'SHORT' },
  ] as const;

  const markets = inputs.map((input) => ({
    market: input.market,
    direction: input.direction,
    ...evaluateFormulaAiAutoRehearsal({
      ...input,
      ...common,
      futuresMarginMode: input.market === 'CRYPTO_FUTURES' ? 'isolated' : undefined,
      futuresLeverage: input.market === 'CRYPTO_FUTURES' ? 2 : undefined,
    }),
  }));

  const vetoControl = evaluateFormulaAiAutoRehearsal({
    strategyId: 'KR_PRESSURE_BREAKOUT_V1',
    market: 'KR_STOCK',
    direction: 'BUY',
    ...common,
    aiDecision: 'VETO',
  });

  const passed = markets.every((row) => row.wouldActivateLiveAuto)
    && vetoControl.wouldActivateLiveAuto === false
    && paper.paperAutoReady
    && paper.paperFillReady
    && paper.journalReady
    && paper.riskReady;

  response.setHeader('Cache-Control', 'no-store, max-age=0');
  return response.status(200).json({
    ok: true,
    mode: 'ISOLATED_PR_PREVIEW',
    preview: {
      isolated: true,
      passed,
      memberDataRead: false,
      providerCredentialsRead: false,
      providerGateSimulated: true,
      credentialGateSimulated: true,
      telegramDelivered: false,
      telegramMutationAttempted: false,
      persistentJournalRead: false,
      productionDataRead: false,
    },
    rehearsalPolicy: FORMULA_AI_REHEARSAL_POLICY_VERSION,
    exceptionPolicy: FORMULA_AI_LIVE_EXCEPTION_POLICY_VERSION,
    signal: {
      deterministicRuleReady: true,
      productionSignalCreated: false,
    },
    ai: {
      positiveDecision: 'PASS',
      vetoDecision: 'VETO',
      vetoBlocked: vetoControl.wouldActivateLiveAuto === false,
      liveAiProviderInvokedByThisEndpoint: false,
    },
    paper,
    journal: {
      paperJournalProjectionReady: paper.journalReady,
      journalEndpointReadReady: false,
      ready: paper.journalReady,
      persistentMutationPerformedByThisEndpoint: false,
    },
    telegram: {
      ready: true,
      testMessageRequestedByThisEndpoint: false,
    },
    futures: {
      marginMode: 'isolated',
      maxLeverage: 7,
      isolatedReady: true,
      leverageReady: true,
    },
    markets,
    wouldActivateLiveAuto: passed,
    executionAuthority: 'NONE',
    realOrderSubmitted: false,
    actualOrderSubmitted: false,
    exchangeRequestSent: false,
    providerMutationRequests: 0,
    productionMutationAllowed: false,
    liveTradingActivated: false,
    automaticLiveExecutionActivated: false,
  });
});

export default router;
