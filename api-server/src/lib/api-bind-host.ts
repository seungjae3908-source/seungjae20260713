const EXPLICIT_BIND_HOSTS = new Set(['0.0.0.0', '127.0.0.1', '::1']);

function enabled(environment: NodeJS.ProcessEnv, name: string) {
  return environment[name] === 'true';
}

function stagingReadonlyCredentialRuntime(environment: NodeJS.ProcessEnv) {
  const hasMasterKey = Boolean(environment.TRADING_CREDENTIAL_MASTER_KEY?.trim());
  const privateReadEnabled = enabled(environment, 'UPBIT_ACCOUNT_READ_ENABLED')
    || enabled(environment, 'BITGET_ACCOUNT_READ_ENABLED');
  const mutationAuthorityDisabled = !enabled(environment, 'LIVE_TRADING_ENABLED')
    && !enabled(environment, 'AUTO_TRADING_ENABLED')
    && !enabled(environment, 'TOSS_ORDER_ENABLED')
    && !enabled(environment, 'UPBIT_ORDER_ENABLED')
    && !enabled(environment, 'BITGET_ORDER_ENABLED')
    && !enabled(environment, 'TRANSFER_ENABLED')
    && !enabled(environment, 'WITHDRAWAL_ENABLED');

  return environment.APP_ENV === 'staging'
    && hasMasterKey
    && privateReadEnabled
    && mutationAuthorityDisabled;
}

export function resolveApiBindHost(environment: NodeJS.ProcessEnv = process.env) {
  const explicit = environment.API_BIND_HOST?.trim();
  if (explicit) {
    if (!EXPLICIT_BIND_HOSTS.has(explicit)) throw new Error('API_BIND_HOST_INVALID');
    return explicit;
  }

  // A staging runtime that temporarily receives real private-read credentials
  // fails closed to loopback unless an operator explicitly overrides the bind host.
  if (stagingReadonlyCredentialRuntime(environment)) return '127.0.0.1';

  return '0.0.0.0';
}
