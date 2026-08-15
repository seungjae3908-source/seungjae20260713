import { AccountReadonlyError } from '../account-readonly.errors';
import { emptySnapshot, maskAccountRef, nullableNumber, type CanonicalAccount, type CanonicalAccountSnapshot } from '../account-readonly.contract';

export type TossCredentials = { clientId: string; clientSecret: string; accountSeq?: string };
export type ReadonlyTransport = (request: { method: 'GET' | 'POST'; path: string; headers: Record<string, string>; body: string | null; signal?: AbortSignal }) => Promise<{ status: number; headers?: Record<string, string>; body: unknown }>;
const PRIVATE_GETS = new Set(['/api/v1/accounts', '/api/v1/holdings', '/api/v1/buying-power', '/api/v1/orders']);

export class TossTokenManager {
  private cached: { token: string; expiresAt: number } | null = null;
  private pending: Promise<string> | null = null;
  constructor(private readonly transport: ReadonlyTransport, private readonly now = () => Date.now()) {}
  async token(credentials: TossCredentials, signal?: AbortSignal): Promise<string> {
    if (this.cached && this.cached.expiresAt - 30_000 > this.now()) return this.cached.token;
    if (this.pending) return this.pending;
    this.pending = this.issue(credentials, signal).finally(() => { this.pending = null; });
    return this.pending;
  }
  private async issue(credentials: TossCredentials, signal?: AbortSignal) {
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: credentials.clientId, client_secret: credentials.clientSecret }).toString();
    const response = await this.transport({ method: 'POST', path: '/oauth2/token', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal });
    if (response.status === 401) throw new AccountReadonlyError('AUTH_FAILED');
    if (response.status === 429) throw new AccountReadonlyError('RATE_LIMITED', true);
    const row = response.body && typeof response.body === 'object' ? response.body as Record<string, unknown> : {};
    const token = String(row.access_token ?? ''); const expires = nullableNumber(row.expires_in);
    if (!token || expires === null || expires <= 0) throw new AccountReadonlyError('TOSS_TOKEN_RESPONSE_INVALID');
    this.cached = { token, expiresAt: this.now() + expires * 1000 }; return token;
  }
}

export class TossReadonlyProvider {
  constructor(private readonly transport: ReadonlyTransport, private readonly tokens: TossTokenManager, private readonly now = () => new Date()) {}
  async request(path: string, credentials: TossCredentials, signal?: AbortSignal) {
    if (!PRIVATE_GETS.has(path)) throw new AccountReadonlyError('READONLY_PATH_REJECTED');
    const token = await this.tokens.token(credentials, signal);
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
    if (path !== '/api/v1/accounts') {
      if (!credentials.accountSeq) throw new AccountReadonlyError('TOSS_ACCOUNT_NOT_CONFIGURED');
      headers['X-Tossinvest-Account'] = credentials.accountSeq;
    }
    const response = await this.transport({ method: 'GET', path, headers, body: null, signal });
    if (response.status === 401) throw new AccountReadonlyError('AUTH_FAILED');
    if (response.status === 429) throw new AccountReadonlyError('RATE_LIMITED', true, nullableNumber(response.headers?.['retry-after']) === null ? null : Number(response.headers?.['retry-after']) * 1000);
    if (response.status >= 400) throw new AccountReadonlyError(`TOSS_HTTP_${response.status}`, response.status >= 500);
    return response.body;
  }
  async snapshot(credentials: TossCredentials, signal?: AbortSignal): Promise<CanonicalAccountSnapshot> {
    const checkedAt = this.now().toISOString();
    const [accountsRaw, holdingsRaw, krwRaw, usdRaw] = await Promise.all([
      this.request('/api/v1/accounts', credentials, signal), this.request('/api/v1/holdings', credentials, signal),
      this.request('/api/v1/buying-power', credentials, signal), this.request('/api/v1/buying-power', credentials, signal),
    ]);
    const rows = (value: unknown) => { const r = value && typeof value === 'object' ? value as Record<string, unknown> : {}; const data = r.result ?? r.data ?? value; return Array.isArray(data) ? data : data && typeof data === 'object' ? [data as Record<string, unknown>] : []; };
    const accounts: CanonicalAccount[] = rows(accountsRaw).map((r) => ({ market: String((r as any).market ?? 'KR').toUpperCase() === 'US' ? 'US' as const : 'KR' as const, accountRef: maskAccountRef((r as any).accountSeq ?? credentials.accountSeq), currency: (r as any).currency ? String((r as any).currency) : null, buyingPower: null }));
    const positions = rows(holdingsRaw).map((r) => ({ market: String((r as any).market ?? ''), symbol: String((r as any).symbol ?? ''), quantity: nullableNumber((r as any).quantity), availableQuantity: nullableNumber((r as any).availableQuantity), averageEntryPrice: nullableNumber((r as any).averagePurchasePrice), currentPrice: nullableNumber((r as any).currentPrice), marketValue: nullableNumber((r as any).evaluatedAmount ?? (r as any).marketValue), unrealizedPnl: nullableNumber((r as any).profitLoss), unrealizedPnlPercent: nullableNumber((r as any).profitLossRate), leverage: null, liquidationPrice: null, marginMode: null, side: null }));
    const powers = [krwRaw, usdRaw].flatMap(rows); powers.forEach((r, i) => accounts.push({ market: i ? 'US' : 'KR', accountRef: maskAccountRef(credentials.accountSeq), currency: String((r as any).currency ?? (i ? 'USD' : 'KRW')), buyingPower: nullableNumber((r as any).buyingPower ?? (r as any).amount) }));
    return { ...emptySnapshot('toss', 'CONNECTED', checkedAt), connected: true, accounts, positions, lastGoodAt: checkedAt };
  }
}
