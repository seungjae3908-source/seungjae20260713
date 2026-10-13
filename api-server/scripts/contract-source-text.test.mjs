import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { normalizeContractSource, readContractSource } from './contract-source-text.mjs';

test('contract input changes CRLF only, preserving content, spaces and bare CR', () => {
  assert.equal(normalizeContractSource('한글 \r\nx\n\r\nbare\rcarriage\t\r\n'),
    '한글 \nx\n\nbare\rcarriage\t\n');
  assert.equal(normalizeContractSource(''), '');
  assert.equal(normalizeContractSource('\uFEFFheader\n'), '\uFEFFheader\n');
});

test('LF input is byte-equivalent and normalization is idempotent', () => {
  const source = 'deny = true;\n// keep safety tokens and trailing spaces \n';
  assert.equal(normalizeContractSource(source), source);
  const normalized = normalizeContractSource(source.replaceAll('\n', '\r\n'));
  assert.equal(normalizeContractSource(normalized), source);
});

test('missing or non-text evidence is never converted to empty passing evidence', () => {
  for (const value of [undefined, null, 0, {}, Buffer.from('deny')]) {
    assert.throws(() => normalizeContractSource(value), /CONTRACT_SOURCE_TEXT_REQUIRED/);
  }
});

test('the file reader applies exactly the same text-only normalization', async () => {
  const file = new URL('./verify-ai-preview-diagnostic-contract.mjs', import.meta.url);
  assert.equal(await readContractSource(file),
    normalizeContractSource(await readFile(file, 'utf8')));
});

test('file read failures remain failures', async () => {
  await assert.rejects(readContractSource(new URL('./missing-contract-source.fixture', import.meta.url)),
    { code: 'ENOENT' });
});

test('Phase 12 keeps every original command and includes newline safety regressions', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const commands = pkg.scripts['test:phase12'].split(' && ');
  const regression = 'node --test ./scripts/contract-source-text.test.mjs ./scripts/verify-ai-preview-diagnostic-contract.test.mjs';
  assert.equal(commands.filter(command => command === regression).length, 1);
  const original = commands.filter(command => command !== regression).join(' && ');
  assert.equal(createHash('sha256').update(original).digest('hex'),
    'b4e83e25f79f1f5128f9ce82ff80153b43ddb69ed1b020a642c93b3217f6ee9c');
});

test('local verification repair cannot change dependencies or package metadata', async () => {
  const { scripts, ...metadata } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(createHash('sha256').update(JSON.stringify(metadata)).digest('hex'),
    '5e2c3b4392d87ed3be8653b96aa082af26a6929b399628f612630018900f8329');
});
