const REAL_BASE_URL = process.env.KIWOOM_BASE_URL?.trim() || 'http://158.247.235.32:3000/kiwoom';
const MOCK_BASE_URL = 'https://mockapi.kiwoom.com';
const REQUEST_TIMEOUT_MS = 15_000;

type JsonRecord = Record<string, unknown>;

export type KiwoomReadonlyCredentials = {
  appKey: string;
  secretKey: string;
};

type RequestInput = {
  apiId: string;
  path: string;
  body: JsonRecord;
};

function isMockMode() {
  return process.env.KIWOOM_MODE?.trim().toLowerCase() === 'mock';
}

function baseUrl() {
  return isMockMode() ? MOCK_BASE_URL : REAL_BASE_URL;
}

function proxyHeaders(): Record<string, string> {
  if (isMockMode()) return {};
  const proxyKey = process.env.KIWOOM_PROXY_KEY?.trim();
  if (!proxyKey) throw new Error('KIWOOM_PROXY_KEY_NOT_CONFIGURED');
  return { 'x-proxy-key': proxyKey };
}

async function readJson(response: Response): Promise<JsonRecord> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as JsonRecord;
  } catch {
    throw new Error(`KIWOOM_NON_JSON_RESPONSE_${response.status}`);
  }
}

function returnCode(data: JsonRecord) {
  if (data.return_code == null || data.return_code === '') return 0;
  const parsed = Number(data.return_code);
  return Number.isFinite(parsed) ? parsed : -1;
}

function returnMessage(data: JsonRecord) {
  return typeof data.return_msg === 'string' && data.return_msg.trim()
    ? data.return_msg.trim()
    : 'KIWOOM_REQUEST_FAILED';
}

async function fetchWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('KIWOOM_ACCOUNT_TIMEOUT');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function issueToken(credentials: KiwoomReadonlyCredentials) {
  const appKey = credentials.appKey.trim();
  const secretKey = credentials.secretKey.trim();
  if (!appKey || !secretKey) throw new Error('KIWOOM_PRIVATE_KEYS_NOT_CONFIGURED');

  const response = await fetchWithTimeout(`${baseUrl()}/oauth2/token`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json;charset=UTF-8',
      ...proxyHeaders(),
    },
    body: JSON.stringify({ grant_type: 'client_credentials', appkey: appKey, secretkey: secretKey }),
  });
  const data = await readJson(response);
  const token = typeof data.token === 'string' ? data.token.trim() : '';
  if (!response.ok || returnCode(data) !== 0 || !token) {
    throw new Error(`KIWOOM_TOKEN_FAILED:${returnMessage(data)}`);
  }
  return token;
}

export function kiwoomReadonlyEnvironmentCredentials(): KiwoomReadonlyCredentials | null {
  const appKey = process.env.KIWOOM_APP_KEY?.trim() ?? '';
  const secretKey = process.env.KIWOOM_APP_SECRET?.trim() ?? '';
  return appKey && secretKey ? { appKey, secretKey } : null;
}

export function kiwoomReadonlyInfrastructureConfigured() {
  return isMockMode() || Boolean(process.env.KIWOOM_PROXY_KEY?.trim());
}

export function kiwoomReadonlyMode() {
  return isMockMode() ? 'mock' : 'real';
}

export function createKiwoomReadonlyAccountClient(credentials: KiwoomReadonlyCredentials) {
  let tokenPromise: Promise<string> | null = null;
  const token = () => {
    tokenPromise ??= issueToken(credentials);
    return tokenPromise;
  };

  return {
    async request({ apiId, path, body }: RequestInput) {
      const accessToken = await token();
      const response = await fetchWithTimeout(`${baseUrl()}${path}`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json;charset=UTF-8',
          authorization: `Bearer ${accessToken}`,
          'api-id': apiId,
          ...proxyHeaders(),
        },
        body: JSON.stringify(body),
      });
      const data = await readJson(response);
      if (!response.ok || returnCode(data) !== 0) {
        throw new Error(`KIWOOM_ACCOUNT_REQUEST_FAILED:${apiId}:${returnMessage(data)}`);
      }
      return data;
    },
  };
}
