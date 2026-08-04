#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TEXT_EXTENSIONS = new Set([
  '.css', '.csv', '.html', '.htm', '.js', '.json', '.log', '.map', '.md',
  '.mjs', '.ndjson', '.svg', '.txt', '.xml', '.yaml', '.yml',
]);
const TRACE_PATH_PATTERN = /(?:^|[\\/])(?:trace(?:\.[^\\/]*)?|traces)(?:$|[\\/])/i;
const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+\/-]{8,}=*/gi;
const SENSITIVE_KEY_PATTERN = /^(?:authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|supabase(?:[_-]?(?:anon|secret|service(?:[_-]?role)?))?[_-]?key|password)$/i;
const SENSITIVE_ASSIGNMENT_PATTERN = /(["']?)(authorization|cookie|set-cookie|access[_-]?token|refresh[_-]?token|api[_-]?key|apikey|supabase(?:[_-]?(?:anon|secret|service(?:[_-]?role)?))?[_-]?key|password)\1\s*([:=])\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;<>]+)/gi;
const HEADER_PAIR_PATTERN = /(["']name["']\s*:\s*["'])(authorization|cookie|set-cookie|apikey)(["'][\s\S]{0,200}?["']value["']\s*:\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/gi;
const REDACTED = '[REDACTED]';
const REDACTED_EMAIL = '[REDACTED_EMAIL]';

function isTextFile(filePath, buffer) {
  if (TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase())) return true;
  if (buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_192));
  return !sample.includes(0);
}

function sanitizeString(value) {
  return value
    .replace(BEARER_PATTERN, REDACTED)
    .replace(JWT_PATTERN, REDACTED)
    .replace(EMAIL_PATTERN, REDACTED_EMAIL)
    .replace(HEADER_PAIR_PATTERN, (_match, prefix, header, between) => `${prefix}${header}${between}"${REDACTED}"`)
    .replace(SENSITIVE_ASSIGNMENT_PATTERN, (_match, quote, key, separator) => `${quote}${key}${quote}${separator}"${REDACTED}"`);
}

function sanitizeJson(value) {
  if (Array.isArray(value)) return value.map(sanitizeJson);
  if (value && typeof value === 'object') {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeJson(child);
      }
    }
    const headerName = typeof result.name === 'string' ? result.name : '';
    if (SENSITIVE_KEY_PATTERN.test(headerName) && Object.hasOwn(result, 'value')) {
      result.value = REDACTED;
    }
    return result;
  }
  return typeof value === 'string' ? sanitizeString(value) : value;
}

function sanitizeText(filePath, text) {
  if (path.extname(filePath).toLowerCase() === '.json') {
    try {
      const parsed = JSON.parse(text);
      const sanitized = sanitizeJson(parsed);
      if (JSON.stringify(sanitized) === JSON.stringify(parsed)) return text;
      return `${JSON.stringify(sanitized, null, 2)}\n`;
    } catch {
      // Invalid JSON is still scanned and sanitized as text, then fails later if unsafe.
    }
  }
  return sanitizeString(text);
}

function unsafeFinding(text) {
  BEARER_PATTERN.lastIndex = 0;
  JWT_PATTERN.lastIndex = 0;
  EMAIL_PATTERN.lastIndex = 0;
  SENSITIVE_ASSIGNMENT_PATTERN.lastIndex = 0;
  HEADER_PAIR_PATTERN.lastIndex = 0;
  if (BEARER_PATTERN.test(text)) return 'bearer-token';
  if (JWT_PATTERN.test(text)) return 'jwt';
  if (EMAIL_PATTERN.test(text)) return 'email';
  const assignment = text.match(SENSITIVE_ASSIGNMENT_PATTERN);
  if (assignment && !assignment.every((item) => item.includes(REDACTED))) return 'sensitive-assignment';
  const headerPair = text.match(HEADER_PAIR_PATTERN);
  if (headerPair && !headerPair.every((item) => item.includes(REDACTED))) return 'sensitive-header';
  return null;
}

function listFiles(root) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = path.relative(root, absolute);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error(`Artifact sanitizer rejects symlink: ${relative}`);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) files.push({ absolute, relative });
    }
  };
  walk(root);
  return files;
}

export function sanitizeStagingArtifacts(rootDirectory) {
  const root = path.resolve(rootDirectory);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Staging artifact directory is missing');
  }

  const files = listFiles(root);
  if (files.length === 0) throw new Error('Staging artifact directory is empty');
  let sanitizedFiles = 0;
  let redactionCount = 0;

  for (const file of files) {
    if (TRACE_PATH_PATTERN.test(file.relative)) {
      throw new Error(`Raw Playwright trace is forbidden: ${file.relative}`);
    }
    const buffer = fs.readFileSync(file.absolute);
    if (!isTextFile(file.absolute, buffer)) continue;
    const original = buffer.toString('utf8');
    const sanitized = sanitizeText(file.absolute, original);
    if (sanitized !== original) {
      fs.writeFileSync(file.absolute, sanitized, { mode: 0o600 });
      sanitizedFiles += 1;
      redactionCount += 1;
    }
  }

  const verifiedFiles = listFiles(root);
  for (const file of verifiedFiles) {
    if (TRACE_PATH_PATTERN.test(file.relative)) {
      throw new Error(`Raw Playwright trace is forbidden: ${file.relative}`);
    }
    const buffer = fs.readFileSync(file.absolute);
    const searchable = isTextFile(file.absolute, buffer)
      ? buffer.toString('utf8')
      : buffer.toString('latin1');
    const finding = unsafeFinding(searchable);
    if (finding) throw new Error(`Unsafe staging artifact content (${finding}) in ${file.relative}`);
  }

  return {
    fileCount: verifiedFiles.length,
    sanitizedFiles,
    redactionCount,
    rawTraceCount: 0,
    safe: true,
  };
}

const invokedAsScript = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedAsScript) {
  const root = process.argv[2] || process.env.STAGING_ARTIFACT_DIR;
  if (!root) {
    console.error('Staging artifact directory argument is required.');
    process.exit(1);
  }
  try {
    const result = sanitizeStagingArtifacts(root);
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Staging artifact sanitization failed');
    process.exit(1);
  }
}
