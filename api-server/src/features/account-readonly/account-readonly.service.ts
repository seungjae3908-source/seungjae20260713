import { emptySnapshot, type AccountProvider, type CanonicalAccountSnapshot } from './account-readonly.contract';
import { classifyProviderError } from './account-readonly.errors';

export type AccountReader = (signal?: AbortSignal) => Promise<CanonicalAccountSnapshot>;
export class AccountReadonlyService {
  private lastGood = new Map<AccountProvider, CanonicalAccountSnapshot>();
  constructor(private readonly readers: Partial<Record<AccountProvider, AccountReader>>, private readonly flags: Partial<Record<AccountProvider, boolean>>, private readonly now = () => new Date()) {}
  async read(provider: AccountProvider, signal?: AbortSignal) {
    if (!this.flags[provider]) return emptySnapshot(provider, 'NOT_CONFIGURED', this.now().toISOString(), 'ACCOUNT_READ_DISABLED');
    const reader = this.readers[provider]; if (!reader) return emptySnapshot(provider, 'CONFIGURED_UNVERIFIED', this.now().toISOString(), 'READER_NOT_CONFIGURED');
    try { const value = await reader(signal); this.lastGood.set(provider, value); return value; }
    catch (error) { const classified = classifyProviderError(error); const prior = this.lastGood.get(provider); if (prior) return { ...prior, status: 'STALE' as const, stale: true, checkedAt: this.now().toISOString(), errorCode: classified.code }; const status = classified.code === 'AUTH_FAILED' ? 'AUTH_FAILED' : classified.code === 'RATE_LIMITED' ? 'RATE_LIMITED' : 'UNAVAILABLE'; return emptySnapshot(provider, status, this.now().toISOString(), classified.code); }
  }
}
