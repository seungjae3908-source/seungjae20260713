import { emptySnapshot, type AccountProvider, type CanonicalAccountSnapshot } from './account-readonly.contract';
import { classifyProviderError } from './account-readonly.errors';

export type AccountReadScope = {
  userId: string;
  accessToken: string;
};

export type AccountReader = (
  scope: AccountReadScope,
  signal?: AbortSignal,
) => Promise<CanonicalAccountSnapshot>;

export class AccountReadonlyService {
  private lastGood = new Map<string, CanonicalAccountSnapshot>();

  constructor(
    private readonly readers: Partial<Record<AccountProvider, AccountReader>>,
    private readonly flags: Partial<Record<AccountProvider, boolean>>,
    private readonly now = () => new Date(),
  ) {}

  async read(scope: AccountReadScope, provider: AccountProvider, signal?: AbortSignal) {
    const userId = scope.userId.trim();
    const accessToken = scope.accessToken.trim();
    if (!userId || !accessToken) {
      return emptySnapshot(
        provider,
        'AUTH_FAILED',
        this.now().toISOString(),
        'ACCOUNT_REQUEST_SCOPE_REQUIRED',
      );
    }

    if (!this.flags[provider]) {
      return emptySnapshot(provider, 'NOT_CONFIGURED', this.now().toISOString(), 'ACCOUNT_READ_DISABLED');
    }

    const reader = this.readers[provider];
    if (!reader) {
      return emptySnapshot(
        provider,
        'CONFIGURED_UNVERIFIED',
        this.now().toISOString(),
        'READER_NOT_CONFIGURED',
      );
    }

    const cacheKey = `${userId}:${provider}`;
    try {
      const value = await reader({ userId, accessToken }, signal);
      this.lastGood.set(cacheKey, value);
      return value;
    } catch (error) {
      const classified = classifyProviderError(error);
      const prior = this.lastGood.get(cacheKey);
      if (prior) {
        return {
          ...prior,
          status: 'STALE' as const,
          stale: true,
          checkedAt: this.now().toISOString(),
          errorCode: classified.code,
        };
      }

      const status = classified.code === 'AUTH_FAILED'
        ? 'AUTH_FAILED'
        : classified.code === 'RATE_LIMITED'
          ? 'RATE_LIMITED'
          : 'UNAVAILABLE';
      return emptySnapshot(provider, status, this.now().toISOString(), classified.code);
    }
  }
}
