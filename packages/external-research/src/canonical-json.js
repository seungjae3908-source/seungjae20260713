import { createHash } from 'node:crypto';
import { fail, requirePlainObject } from './errors.js';

function normalize(value, stack) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('CANONICAL_JSON_NON_FINITE_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'object') fail('CANONICAL_JSON_UNSUPPORTED_VALUE');
  if (stack.has(value)) fail('CANONICAL_JSON_CYCLE');

  stack.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((entry) => normalize(entry, stack));
  } else {
    requirePlainObject(value, 'CANONICAL_JSON_NON_PLAIN_OBJECT');
    result = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] === undefined) fail('CANONICAL_JSON_UNDEFINED_VALUE');
      result[key] = normalize(value[key], stack);
    }
  }
  stack.delete(value);
  return result;
}

export function canonicalJson(value) {
  return JSON.stringify(normalize(value, new Set()));
}

export function sha256Hex(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return value;
}
