'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { findUniqueEvidenceFile } = require('./production-preactivation-evidence-paths.cjs');

function withTemporaryDirectory(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'production-preactivation-evidence-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('accepts a unique evidence file at the artifact root', () => {
  withTemporaryDirectory((root) => {
    const expected = path.join(root, 'receipt.json');
    fs.writeFileSync(expected, '{}');
    assert.equal(findUniqueEvidenceFile(root, 'receipt.json'), expected);
  });
});

test('accepts a unique evidence file nested inside the downloaded artifact', () => {
  withTemporaryDirectory((root) => {
    const nested = path.join(root, 'production-account-readonly-artifacts');
    fs.mkdirSync(nested);
    const expected = path.join(nested, 'production-account-readonly-live-qa.json');
    fs.writeFileSync(expected, '{}');
    assert.equal(
      findUniqueEvidenceFile(root, 'production-account-readonly-live-qa.json'),
      expected,
    );
  });
});

test('fails closed when the expected evidence file is missing', () => {
  withTemporaryDirectory((root) => {
    assert.throws(
      () => findUniqueEvidenceFile(root, 'missing.json'),
      /PRODUCTION_PREACTIVATION_EVIDENCE_MISSING:missing\.json/,
    );
  });
});

test('fails closed when duplicate evidence files exist in separate artifacts', () => {
  withTemporaryDirectory((root) => {
    for (const directory of ['artifact-a', 'artifact-b']) {
      const nested = path.join(root, directory);
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'receipt.json'), '{}');
    }
    assert.throws(
      () => findUniqueEvidenceFile(root, 'receipt.json'),
      /PRODUCTION_PREACTIVATION_EVIDENCE_DUPLICATE:receipt\.json:2/,
    );
  });
});
