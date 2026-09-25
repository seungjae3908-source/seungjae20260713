import type { AccountProvider, CanonicalAccountSnapshot } from './account-readonly.contract';
import { accountReadonlyCredentialConfigured } from './account-readonly.repository';
import { accountReadonlyRuntimeService } from './account-readonly.runtime-service';

export type PortfolioAccountReadResult = {
  provider: AccountProvider;
  configured: boolean | null;
  snapshot: CanonicalAccountSnapshot | null;
  errorCode: string | null;
};

export type PortfolioAccountSourceDependencies = {
  credentialConfigured: (userId: string, provider: AccountProvider) => Promise<boolean>;
  read: (
    scope: { userId: string; accessToken: string },
    provider: AccountProvider,
  ) => Promise<CanonicalAccountSnapshot>;
};

const defaultDependencies: PortfolioAccountSourceDependencies = {
  credentialConfigured: accountReadonlyCredentialConfigured,
  read: (scope, provider) => accountReadonlyRuntimeService.read(scope, provider),
};

export async function readPortfolioAccountSources(input: {
  userId: string;
  accessToken: string;
  providers: readonly AccountProvider[];
}, dependencies: PortfolioAccountSourceDependencies = defaultDependencies): Promise<PortfolioAccountReadResult[]> {
  const userId = input.userId.trim();
  const accessToken = input.accessToken.trim();
  if (!userId || !accessToken) {
    return input.providers.map((provider) => ({
      provider,
      configured: null,
      snapshot: null,
      errorCode: 'ACCOUNT_REQUEST_SCOPE_REQUIRED',
    }));
  }

  return Promise.all(input.providers.map(async (provider) => {
    try {
      const configured = await dependencies.credentialConfigured(userId, provider);
      if (!configured) return { provider, configured: false, snapshot: null, errorCode: null };
      const snapshot = await dependencies.read({ userId, accessToken }, provider);
      return { provider, configured: true, snapshot, errorCode: snapshot.errorCode };
    } catch {
      return {
        provider,
        configured: null,
        snapshot: null,
        errorCode: 'ACCOUNT_CREDENTIAL_METADATA_UNAVAILABLE',
      };
    }
  }));
}
