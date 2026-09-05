import { expect, test as base, type Page, type TestInfo } from '@playwright/test';

type ConsoleEvidence = {
  type: string;
  text: string;
};

type NetworkEvidence = {
  kind: 'requestfailed' | 'http';
  method: string;
  url: string;
  status?: number;
  failure?: string | null;
};

type PageEvidence = {
  message: string;
};

type FullProductEvidence = {
  console: ConsoleEvidence[];
  network: NetworkEvidence[];
  pageErrors: PageEvidence[];
};

const MAX_ENTRIES = 200;
const MAX_TEXT = 2_000;

function redact(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]')
    .replace(/(access[_-]?token|refresh[_-]?token|api[_-]?key|secret|password|authorization|cookie)(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]')
    .slice(0, MAX_TEXT);
}

function safeUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return redact(value.split('?')[0]?.split('#')[0] ?? value);
  }
}

function pushBounded<T>(target: T[], value: T) {
  if (target.length < MAX_ENTRIES) target.push(value);
}

function installEvidence(page: Page): FullProductEvidence {
  const evidence: FullProductEvidence = { console: [], network: [], pageErrors: [] };

  page.on('console', (message) => {
    pushBounded(evidence.console, {
      type: message.type(),
      text: redact(message.text()),
    });
  });

  page.on('pageerror', (error) => {
    pushBounded(evidence.pageErrors, { message: redact(error.message) });
  });

  page.on('requestfailed', (request) => {
    pushBounded(evidence.network, {
      kind: 'requestfailed',
      method: request.method(),
      url: safeUrl(request.url()),
      failure: redact(request.failure()?.errorText ?? 'UNKNOWN_REQUEST_FAILURE'),
    });
  });

  page.on('response', (response) => {
    if (response.status() < 400) return;
    pushBounded(evidence.network, {
      kind: 'http',
      method: response.request().method(),
      url: safeUrl(response.url()),
      status: response.status(),
    });
  });

  return evidence;
}

async function attachEvidence(testInfo: TestInfo, evidence: FullProductEvidence) {
  if (testInfo.status === testInfo.expectedStatus) return;
  await testInfo.attach('full-product-console.json', {
    body: Buffer.from(JSON.stringify({ console: evidence.console, pageErrors: evidence.pageErrors }, null, 2)),
    contentType: 'application/json',
  });
  await testInfo.attach('full-product-network.json', {
    body: Buffer.from(JSON.stringify({ network: evidence.network }, null, 2)),
    contentType: 'application/json',
  });
}

export const test = base.extend<{ fullProductEvidence: FullProductEvidence }>({
  fullProductEvidence: async ({ page }, use, testInfo) => {
    const evidence = installEvidence(page);
    await use(evidence);
    await attachEvidence(testInfo, evidence);
  },
});

export { expect };
