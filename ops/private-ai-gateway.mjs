#!/usr/bin/env node
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const DEFAULT_MODEL = 'qwen3:4b';
const DEFAULT_LISTEN_HOST = '127.0.0.1';
const DEFAULT_LISTEN_PORT = 18190;
const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1/';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function intFromEnv(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizedLoopbackUrl(rawValue) {
  const url = new URL(rawValue);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('PRIVATE_AI_UPSTREAM_PROTOCOL_FORBIDDEN');
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error('PRIVATE_AI_UPSTREAM_MUST_BE_LOOPBACK');
  }
  url.username = '';
  url.password = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function assertLoopbackListenHost(host) {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error('PRIVATE_AI_LISTEN_HOST_MUST_BE_LOOPBACK');
  }
}

export function buildPrivateAiConfig(env = process.env) {
  const listenHost = String(env.PRIVATE_AI_LISTEN_HOST || DEFAULT_LISTEN_HOST).trim();
  assertLoopbackListenHost(listenHost);

  return Object.freeze({
    listenHost,
    listenPort: intFromEnv(env.PRIVATE_AI_LISTEN_PORT, DEFAULT_LISTEN_PORT, 0, 65_535),
    ollamaBaseUrl: normalizedLoopbackUrl(String(env.PRIVATE_AI_OLLAMA_BASE_URL || DEFAULT_OLLAMA_BASE_URL).trim()),
    model: String(env.PRIVATE_AI_MODEL || DEFAULT_MODEL).trim() || DEFAULT_MODEL,
    maxConcurrency: intFromEnv(env.PRIVATE_AI_MAX_CONCURRENCY, 1, 1, 2),
    timeoutMs: intFromEnv(env.PRIVATE_AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 1_000, 120_000),
    maxBodyBytes: intFromEnv(env.PRIVATE_AI_MAX_BODY_BYTES, DEFAULT_MAX_BODY_BYTES, 4_096, 256 * 1024),
    maxOutputTokens: intFromEnv(env.PRIVATE_AI_MAX_OUTPUT_TOKENS, 800, 64, 2_048),
  });
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function readJsonBody(req, maxBodyBytes) {
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.length;
    if (received > maxBodyBytes) {
      const error = new Error('PRIVATE_AI_BODY_TOO_LARGE');
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    const error = new Error('PRIVATE_AI_INVALID_JSON');
    error.statusCode = 400;
    throw error;
  }
}

function normalizeChatRequest(body, config) {
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    const error = new Error('PRIVATE_AI_MESSAGES_REQUIRED');
    error.statusCode = 400;
    throw error;
  }

  if (body.model && body.model !== config.model) {
    const error = new Error('PRIVATE_AI_MODEL_NOT_ALLOWED');
    error.statusCode = 400;
    throw error;
  }

  const messages = body.messages.slice(0, 64).map((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      const error = new Error('PRIVATE_AI_INVALID_MESSAGE');
      error.statusCode = 400;
      throw error;
    }
    const role = String(message.role || '');
    if (!['system', 'user', 'assistant', 'tool'].includes(role)) {
      const error = new Error('PRIVATE_AI_INVALID_MESSAGE_ROLE');
      error.statusCode = 400;
      throw error;
    }
    return {
      ...message,
      role,
    };
  });

  const maxTokens = intFromEnv(body.max_tokens, config.maxOutputTokens, 1, config.maxOutputTokens);
  const temperature = Number.isFinite(Number(body.temperature))
    ? Math.max(0, Math.min(1, Number(body.temperature)))
    : 0.2;

  const result = {
    model: config.model,
    messages,
    stream: false,
    temperature,
    max_tokens: maxTokens,
  };

  if (body.response_format && typeof body.response_format === 'object') {
    result.response_format = body.response_format;
  }
  if (Array.isArray(body.tools)) {
    result.tools = body.tools.slice(0, 32);
    if (body.tool_choice !== undefined) result.tool_choice = body.tool_choice;
  }
  return result;
}

async function forwardToOllama(body, config, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const endpoint = new URL('chat/completions', config.ollamaBaseUrl);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(normalizeChatRequest(body, config)),
    });

    if (!response.ok) {
      const error = new Error('PRIVATE_AI_UPSTREAM_ERROR');
      error.statusCode = response.status === 429 ? 429 : 503;
      throw error;
    }

    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      const error = new Error('PRIVATE_AI_UPSTREAM_INVALID_RESPONSE');
      error.statusCode = 502;
      throw error;
    }
    return payload;
  } catch (cause) {
    if (cause?.name === 'AbortError') {
      const error = new Error('PRIVATE_AI_UPSTREAM_TIMEOUT');
      error.statusCode = 504;
      throw error;
    }
    throw cause;
  } finally {
    clearTimeout(timeout);
  }
}

export function createPrivateAiGateway(config = buildPrivateAiConfig(), fetchImpl = fetch) {
  let activeRequests = 0;

  return http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');

    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        service: 'private-ai-v1',
        mode: 'local-only',
        model: config.model,
        listenHost: config.listenHost,
        upstream: config.ollamaBaseUrl.origin,
        maxConcurrency: config.maxConcurrency,
        paidExternalAiAllowed: false,
      });
    }

    if (req.method === 'GET' && requestUrl.pathname === '/v1/models') {
      return json(res, 200, {
        object: 'list',
        data: [{ id: config.model, object: 'model', owned_by: 'local' }],
      });
    }

    if (req.method !== 'POST' || requestUrl.pathname !== '/v1/chat/completions') {
      return json(res, 404, { error: { code: 'PRIVATE_AI_NOT_FOUND', message: 'Not found.' } });
    }

    if (activeRequests >= config.maxConcurrency) {
      return json(res, 429, {
        error: {
          code: 'PRIVATE_AI_BUSY',
          message: 'Local AI is busy. Market-data and application workloads have priority.',
        },
      });
    }

    activeRequests += 1;
    try {
      const body = await readJsonBody(req, config.maxBodyBytes);
      const payload = await forwardToOllama(body, config, fetchImpl);
      return json(res, 200, payload);
    } catch (cause) {
      const statusCode = Number.isInteger(cause?.statusCode) ? cause.statusCode : 503;
      const code = typeof cause?.message === 'string' && cause.message.startsWith('PRIVATE_AI_')
        ? cause.message
        : 'PRIVATE_AI_UNAVAILABLE';
      return json(res, statusCode, {
        error: {
          code,
          message: code === 'PRIVATE_AI_UNAVAILABLE'
            ? 'Local AI is unavailable.'
            : code,
        },
      });
    } finally {
      activeRequests -= 1;
    }
  });
}

function isDirectExecution() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}

if (isDirectExecution()) {
  const config = buildPrivateAiConfig();
  const server = createPrivateAiGateway(config);
  server.listen(config.listenPort, config.listenHost, () => {
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : config.listenPort;
    console.log(`[private-ai-v1] listening on http://${config.listenHost}:${port} model=${config.model} mode=local-only`);
  });
}
