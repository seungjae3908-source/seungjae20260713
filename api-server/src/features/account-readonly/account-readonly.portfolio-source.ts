import type { AccountProvider, CanonicalAccountSnapshot } from './account-readonly.contract';
import { accountReadonlyCredentialConfigured } from './account-readonly.repository';
import { accountReadonlyRuntimeService } from './account-readonly.runtime-service';

export type PortfolioAccountReadResult = {
  provider: AccountProvider;
  configured: boolean | null;
  snapshot: CanonicalAccountSnapshot | null;
  errorCode: string | null;
};

export async function readPortfolioAccountSources(input: {
  userId: string;
  accessToken: string;
  providers: readonly AccountProvider[];
}): Promise<PortfolioAccountReadResult[]> {
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
      const configured = await accountReadonlyCredentialConfigured(userId, provider);
      if (!configured) return { provider, configured: false, snapshot: null, errorCode: null };
      const snapshot = await accountReadonlyRuntimeService.read({ userId, accessToken }, provider);
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
