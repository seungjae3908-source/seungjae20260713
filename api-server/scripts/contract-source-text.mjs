import { readFile } from 'node:fs/promises';

// Text-only contract checks must see the same source on Windows and Linux.
// Do not trim content, normalize whitespace, remove bare CR or hide read errors.
export function normalizeContractSource(source) {
  if (typeof source !== 'string') throw new TypeError('CONTRACT_SOURCE_TEXT_REQUIRED');
  return source.replace(/\r\n/gu, '\n');
}

export async function readContractSource(file) {
  return normalizeContractSource(await readFile(file, 'utf8'));
}
