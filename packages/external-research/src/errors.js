export class ExternalResearchValidationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'ExternalResearchValidationError';
    this.code = code;
  }
}

export function fail(code, message = code) {
  throw new ExternalResearchValidationError(code, message);
}

export function requirePlainObject(value, code) {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  return value;
}

export function requireString(value, code) {
  if (typeof value !== 'string' || !value.trim()) fail(code);
  return value.trim().normalize('NFC');
}

export function optionalString(value, code) {
  if (value == null || value === '') return null;
  return requireString(value, code);
}

export function assertExactKeys(value, expected, code) {
  requirePlainObject(value, code);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(code);
}
