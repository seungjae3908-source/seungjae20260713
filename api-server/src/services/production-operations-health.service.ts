export type OperationsHealthState = 'GREEN' | 'DEGRADED' | 'BLOCKED' | 'UNKNOWN';

export type OperationsHealthComponent = Readonly<{
  id: string;
  state: OperationsHealthState;
  required: boolean;
  detail: string;
}>;

type OperationsHealthInput = {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  checkDatabase: () => Promise<void>;
  checkTradeStorage: () => Promise<void>;
};

function configured(value: unknown) {
  return typeof value === 'string' && value.trim().length > 0;
}

function truthy(value: unknown) {
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value ?? '').trim().toLowerCase());
}

async function readonlyCheck(id: string, required: boolean, operation: () => Promise<void>) {
  try {
    await operation();
    return Object.freeze({
      id,
      state: 'GREEN' as const,
      required,
      detail: 'READ_OK',
    });
  } catch {
    return Object.freeze({
      id,
      state: (required ? 'BLOCKED' : 'DEGRADED') as OperationsHealthState,
      required,
      detail: 'READ_FAILED',
    });
  }
}

function configComponent(
  id: string,
  ready: boolean,
  required: boolean,
  readyDetail: string,
  missingDetail: string,
): OperationsHealthComponent {
  return Object.freeze({
    id,
    state: ready ? 'GREEN' : required ? 'BLOCKED' : 'DEGRADED',
    required,
    detail: ready ? readyDetail : missingDetail,
  });
}

function overallState(components: readonly OperationsHealthComponent[]): OperationsHealthState {
  if (components.some((component) => component.required && component.state === 'BLOCKED')) return 'BLOCKED';
  if (components.some((component) => component.state === 'DEGRADED' || component.state === 'BLOCKED')) return 'DEGRADED';
  if (components.some((component) => component.state === 'UNKNOWN')) return 'UNKNOWN';
  return 'GREEN';
}

export async function buildOperationsHealthSnapshot(input: OperationsHealthInput) {
  const env = input.env ?? process.env;
  const checkedAt = (input.now ?? (() => new Date()))().toISOString();
  const [database, tradeStorage] = await Promise.all([
    readonlyCheck('database', true, input.checkDatabase),
    readonlyCheck('trade-storage', false, input.checkTradeStorage),
  ]);

  const aiConfigured = configured(env.GEMINI_API_KEY)
    || configured(env.GOOGLE_GENERATIVE_AI_API_KEY)
    || configured(env.GROQ_API_KEY)
    || configured(env.OPENAI_API_KEY)
    || configured(env.OPENAI_COMPATIBLE_API_KEY);
  const telegramConfigured = configured(env.TELEGRAM_BOT_TOKEN)
    && configured(env.TELEGRAM_WEBHOOK_SECRET)
    && (configured(env.TELEGRAM_STOCK_CHAT_ID)
      || configured(env.TELEGRAM_CRYPTO_CHAT_ID)
      || configured(env.TELEGRAM_CHAT_ID));
  const deploySha = String(
    env.DEPLOY_SHA
      ?? env.VERCEL_GIT_COMMIT_SHA
      ?? env.GITHUB_SHA
      ?? '',
  ).trim().toLowerCase();
  const rollbackSha = String(
    env.PREVIOUS_DEPLOY_SHA
      ?? env.ROLLBACK_SHA
      ?? '',
  ).trim().toLowerCase();

  const components: OperationsHealthComponent[] = [
    Object.freeze({ id: 'api-runtime', state: 'GREEN', required: true, detail: 'REQUEST_SERVED' }),
    database,
    tradeStorage,
    configComponent('ai-provider-config', aiConfigured, false, 'CONFIGURED', 'NOT_CONFIGURED'),
    configComponent('telegram-config', telegramConfigured, false, 'CONFIGURED', 'NOT_CONFIGURED'),
    configComponent('deploy-identity', /^[0-9a-f]{7,64}$/u.test(deploySha), false, 'SHA_KNOWN', 'SHA_UNKNOWN'),
    configComponent('rollback-target', /^[0-9a-f]{7,64}$/u.test(rollbackSha), false, 'SHA_KNOWN', 'SHA_UNKNOWN'),
  ];

  const executionAuthority = String(
    env.executionAuthority
      ?? env.EXECUTION_AUTHORITY
      ?? 'NONE',
  ).trim().toUpperCase() || 'NONE';

  return Object.freeze({
    schemaVersion: 'production-operations-health/v1',
    checkedAt,
    state: overallState(components),
    components: Object.freeze(components),
    deployment: Object.freeze({
      deploySha: /^[0-9a-f]{7,64}$/u.test(deploySha) ? deploySha : null,
      rollbackSha: /^[0-9a-f]{7,64}$/u.test(rollbackSha) ? rollbackSha : null,
      rollbackTargetKnown: /^[0-9a-f]{7,64}$/u.test(rollbackSha),
    }),
    executionGates: Object.freeze({
      liveTrading: truthy(env.LIVE_TRADING),
      autoTrading: truthy(env.AUTO_TRADING),
      realOrderEnabled: truthy(env.REAL_ORDER_ENABLED),
      privateTradingApiAllowed: truthy(env.PRIVATE_TRADING_API_ALLOWED),
      executionAuthority,
    }),
    safety: Object.freeze({
      readOnlySnapshot: true,
      providerProbePerformed: false,
      privateTradingRequestSent: false,
      orderSubmitted: false,
      orderCanceled: false,
      orderAmended: false,
      transferPerformed: false,
      withdrawalPerformed: false,
      secretValuesReturned: false,
    }),
  });
}
