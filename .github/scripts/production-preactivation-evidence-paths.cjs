'use strict';

const fs = require('node:fs');
const path = require('node:path');

function findUniqueEvidenceFile(root, filename) {
  const rootPath = path.resolve(String(root ?? ''));
  const rootStat = fs.lstatSync(rootPath);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('PRODUCTION_PREACTIVATION_EVIDENCE_ROOT_INVALID');
  }

  const matches = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = fs.readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (entry.name === filename) {
          throw new Error(`PRODUCTION_PREACTIVATION_EVIDENCE_SYMLINK:${filename}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        pending.push(candidate);
      } else if (entry.isFile() && entry.name === filename) {
        matches.push(candidate);
      }
    }
  }

  if (matches.length === 0) {
    throw new Error(`PRODUCTION_PREACTIVATION_EVIDENCE_MISSING:${filename}`);
  }
  if (matches.length !== 1) {
    throw new Error(`PRODUCTION_PREACTIVATION_EVIDENCE_DUPLICATE:${filename}:${matches.length}`);
  }
  return matches[0];
}

module.exports = { findUniqueEvidenceFile };
