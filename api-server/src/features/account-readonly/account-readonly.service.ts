import { emptySnapshot, type AccountProvider, type CanonicalAccountSnapshot } from './account-readonly.contract';
import type { BitgetReadonlyDiagnostic } from '../../services/trade-exchange-adapters.service';
import { classifyProviderError, isAccountReadonlyCredentialAccessError } from './account-readonly.errors';

export type AccountReadScope = {
  userId: string;
  accessToken: string;
};

export type AccountReader = (
  scope: AccountReadScope,
  signal?: AbortSignal,
) => Promise<CanonicalAccountSnapshot>;

export type AccountCredentialConfigurationReader = (
  userId: string,
  provider: AccountProvider,
) => Promise<boolean>;

export class AccountReadonlyService {
  private lastGood = new Map<string, CanonicalAccountSnapshot>();
  private bitgetDiagnostics = new WeakMap<CanonicalAccountSnapshot, BitgetReadonlyDiagnostic>();

  constructor(
    private readonly readers: Partial<Record<AccountProvider, AccountReader>>,
    private readonly flags: Partial<Record<AccountProvider, boolean>>,
    private readonly now = () => new Date(),
    private readonly credentialConfigured: AccountCredentialConfigurationReader = async () => false,
  ) {}

  bitgetDiagnosticFor(snapshot: CanonicalAccountSnapshot) {
    return this.bitgetDiagnostics.get(snapshot) ?? null;
  }

  private attachBitgetDiagnostic(
    snapshot: CanonicalAccountSnapshot,
    diagnostic: BitgetReadonlyDiagnostic | null,
  ) {
    if (diagnostic) this.bitgetDiagnostics.set(snapshot, diagnostic);
    return snapshot;
  }

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
      try {
        const configured = await this.credentialConfigured(userId, provider);
        return emptySnapshot(
          provider,
          configured ? 'CONFIGURED_UNVERIFIED' : 'NOT_CONFIGURED',
          this.now().toISOString(),
          configured ? 'ACCOUNT_READ_DISABLED' : 'ACCOUNT_NOT_CONFIGURED',
        );
      } catch {
        return emptySnapshot(
          provider,
          'UNAVAILABLE',
          this.now().toISOString(),
          'ACCOUNT_CREDENTIAL_METADATA_UNAVAILABLE',
        );
      }
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
      if (isAccountReadonlyCredentialAccessError(classified.code)) {
        this.lastGood.delete(cacheKey);
        return this.attachBitgetDiagnostic(
          emptySnapshot(provider, 'AUTH_FAILED', this.now().toISOString(), classified.code),
          classified.bitgetDiagnostic,
        );
      }

      const prior = this.lastGood.get(cacheKey);
      if (prior) {
        return this.attachBitgetDiagnostic({
          ...prior,
          status: 'STALE' as const,
          stale: true,
          checkedAt: this.now().toISOString(),
          errorCode: classified.code,
        }, classified.bitgetDiagnostic);
      }

      const status = classified.code === 'RATE_LIMITED'
        ? 'RATE_LIMITED'
        : 'UNAVAILABLE';
      return this.attachBitgetDiagnostic(
        emptySnapshot(provider, status, this.now().toISOString(), classified.code),
        classified.bitgetDiagnostic,
      );
    }
  }
}