import test from 'node:test';
import assert from 'node:assert/strict';
import { readBoundedTradingProviderJson } from './trading-provider-response.service';

const config = (signal = new AbortController().signal, maxBytes = 100) => ({
  signal, maxBytes, invalidCode: 'FAKE_PROVIDER_RESPONSE_INVALID', boundCode: 'FAKE_PROVIDER_RESPONSE_TOO_LARGE',
});

test('chunked UTF-8 provider JSON is decoded without splitting multibyte characters', async () => {
  const value = { name: '삼성전자', ok: true };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const response = new Response(new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } }));
  assert.deepEqual(await readBoundedTradingProviderJson(response, config()), value);
});

test('byte limit is enforced during streaming even without Content-Length and cancels the remainder', async () => {
  let pulls = 0; let cancelled = false;
  const response = new Response(new ReadableStream({ pull(controller) {
    pulls += 1; controller.enqueue(new Uint8Array(16).fill(32));
  }, cancel() { cancelled = true; } }, { highWaterMark: 0 }));
  await assert.rejects(readBoundedTradingProviderJson(response, config(undefined, 32)), /RESPONSE_TOO_LARGE/);
  assert.equal(cancelled, true);
  assert.equal(pulls, 3, 'unbounded provider stream must stop at the first over-limit chunk');
});

test('UTF-8 byte length, not JavaScript string length or a smaller declared length, determines the bound', async () => {
  await assert.rejects(readBoundedTradingProviderJson(new Response('"가나다"'), config(undefined, 8)), /RESPONSE_TOO_LARGE/);
  await assert.rejects(readBoundedTradingProviderJson(new Response(' '.repeat(20),
    { headers: { 'content-length': '1' } }), config(undefined, 10)), /RESPONSE_TOO_LARGE/);
  assert.deepEqual(await readBoundedTradingProviderJson(new Response('{"a":1}'), config(undefined, 7)), { a: 1 });
});

test('large or invalid declared lengths reject before consuming the body', async () => {
  for (const declared of ['101', '-1', 'not-a-number', '9007199254740992']) {
    let pulls = 0; let cancelled = false;
    const response = new Response(new ReadableStream({ pull() { pulls += 1; },
      cancel() { cancelled = true; } }, { highWaterMark: 0 }), { headers: { 'content-length': declared } });
    await assert.rejects(readBoundedTradingProviderJson(response, config()), /RESPONSE_TOO_LARGE/);
    assert.equal(pulls, 0); assert.equal(cancelled, true);
  }
});

test('timeout abort cancels a stalled response body without accepting its incomplete JSON', async () => {
  const controller = new AbortController(); let cancelled = false;
  const response = new Response(new ReadableStream({ start(stream) {
    stream.enqueue(new TextEncoder().encode('{"ok":'));
  }, cancel() { cancelled = true; } }));
  const reading = readBoundedTradingProviderJson(response, config(controller.signal));
  controller.abort('RAW_SECRET_MUST_NOT_ESCAPE');
  await assert.rejects(reading, (error: unknown) => error instanceof Error
    && error.name === 'AbortError' && !error.message.includes('RAW_SECRET'));
  assert.equal(cancelled, true);
});

test('empty, truncated, malformed UTF-8 and invalid JSON never leak provider body in errors', async () => {
  for (const body of ['', '{"secret":"RAW_SECRET"', new Uint8Array([0xc3]), new Uint8Array([0xc3, 0x28])]) {
    await assert.rejects(readBoundedTradingProviderJson(new Response(body), config()),
      (error: unknown) => error instanceof Error && error.message === 'FAKE_PROVIDER_RESPONSE_INVALID');
  }
});

test('pre-aborted body is cancelled and invalid limits or raw-text error codes are never accepted', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readBoundedTradingProviderJson(new Response('{}'), config(controller.signal)),
    (error: unknown) => error instanceof Error && error.name === 'AbortError');
  for (const input of [{ ...config(), maxBytes: 0 }, { ...config(), maxBytes: 1_000_001 },
    { ...config(), invalidCode: 'RAW:secret' }]) {
    await assert.rejects(readBoundedTradingProviderJson(new Response('{}'), input), /CONFIG_INVALID/);
  }
});
