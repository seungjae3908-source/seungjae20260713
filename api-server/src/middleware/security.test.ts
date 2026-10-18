import test from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';
import {
  createCorsOptionsDelegate,
  isCorsOriginAllowed,
  parseCorsAllowedOrigins,
  productionSecurityHeaders,
} from './security';

const HOSTS = ['', 'lsj119.com'];

test('requests without an Origin header are never blocked', () => {
  assert.equal(isCorsOriginAllowed(undefined, HOSTS, [], 'production'), true);
});

test('the serving host is accepted as same-origin', () => {
  assert.equal(isCorsOriginAllowed('https://lsj119.com', HOSTS, [], 'production'), true);
  assert.equal(isCorsOriginAllowed('https://LSJ119.com', HOSTS, [], 'production'), true);
});

test('an unrelated site is rejected even with credentials', () => {
  assert.equal(isCorsOriginAllowed('https://evil.example', HOSTS, [], 'production'), false);
  assert.equal(isCorsOriginAllowed('https://lsj119.com.evil.example', HOSTS, [], 'production'), false);
  assert.equal(isCorsOriginAllowed('null', HOSTS, [], 'production'), false);
  assert.equal(isCorsOriginAllowed('not a url', HOSTS, [], 'production'), false);
  assert.equal(isCorsOriginAllowed('file:///tmp/x.html', HOSTS, [], 'production'), false);
});

test('configured origins are accepted and trailing slashes are ignored', () => {
  const allowed = parseCorsAllowedOrigins(' https://staging.lsj119.com/ , ,https://app.example ');
  assert.deepEqual(allowed, ['https://staging.lsj119.com', 'https://app.example']);
  assert.equal(isCorsOriginAllowed('https://staging.lsj119.com', HOSTS, allowed, 'production'), true);
  assert.equal(isCorsOriginAllowed('https://other.lsj119.com', HOSTS, allowed, 'production'), false);
});

test('local development hosts are accepted only outside production', () => {
  assert.equal(isCorsOriginAllowed('http://localhost:5173', ['localhost:8080'], [], 'development'), true);
  assert.equal(isCorsOriginAllowed('http://localhost:5173', HOSTS, [], 'production'), false);
});

function delegateResult(headers: Record<string, string>, env: NodeJS.ProcessEnv) {
  const delegate = createCorsOptionsDelegate(env);
  let result: unknown;
  delegate({ headers } as unknown as Request, (error, options) => {
    assert.equal(error, null);
    result = options;
  });
  return result as { origin: boolean; credentials: boolean };
}

test('cors delegate trusts forwarded host and refuses foreign origins', () => {
  const env = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;
  assert.equal(delegateResult({ host: '127.0.0.1:8080', 'x-forwarded-host': 'lsj119.com', origin: 'https://lsj119.com' }, env).origin, true);
  assert.equal(delegateResult({ host: 'lsj119.com', origin: 'https://evil.example' }, env).origin, false);
  assert.equal(delegateResult({ host: 'lsj119.com' }, env).origin, true);
});

test('production security headers set the safe defaults and HSTS only over https', () => {
  const headers = new Map<string, string>();
  const res = { setHeader: (name: string, value: string) => { headers.set(name, value); } } as unknown as Response;
  let nextCalls = 0;
  productionSecurityHeaders({ headers: {}, secure: false } as unknown as Request, res, () => { nextCalls += 1; });
  assert.equal(nextCalls, 1);
  assert.equal(headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(headers.get('X-Frame-Options'), 'SAMEORIGIN');
  assert.equal(headers.has('Strict-Transport-Security'), false);
  productionSecurityHeaders({ headers: { 'x-forwarded-proto': 'https' }, secure: false } as unknown as Request, res, () => undefined);
  assert.match(headers.get('Strict-Transport-Security') ?? '', /^max-age=\d+$/u);
});
