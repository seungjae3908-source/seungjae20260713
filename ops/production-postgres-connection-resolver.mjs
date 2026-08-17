import {
  lstatSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import path from 'node:path';

export const PRODUCTION_PROJECT_REF = 'bawcbkoyovbeajkrnduq';
export const PRODUCTION_ENV_ALLOWLIST = Object.freeze([
  '/opt/stock-app/.env',
  '/opt/stock-app/.env.production',
  '/opt/stock-app/api-server/.env',
  '/opt/stock-app/api-server/.env.production',
]);

const POSTGRES_URI_PATTERN = /^postgres(?:ql)?:\/\//i;

export class ProductionDatabaseResolutionError extends Error {
  constructor(classification, connectionCount = 0) {
    super(classification);
    this.name = 'ProductionDatabaseResolutionError';
    this.classification = classification;
    this.connectionCount = connectionCount;
  }
}

function parseDotenvValue(raw) {
  let value = String(raw ?? '').trim();
  if (!value) return '';

  const quote = value[0];
  if (quote === "'" || quote === '"') {
    if (value.length < 2 || value.at(-1) !== quote) return '';
    value = value.slice(1, -1);
    if (quote === '"') {
      value = value.replace(/\\([\\"$`])/g, '$1');
    }
    return value;
  }

  const inlineComment = value.search(/\s+#/);
  if (inlineComment >= 0) value = value.slice(0, inlineComment).trimEnd();
  return value;
}

function readAllowedEnvValues(filePath) {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw new ProductionDatabaseResolutionError('production_database_env_file_unreadable');
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new ProductionDatabaseResolutionError('production_database_env_file_unsafe');
  }
  if ((stat.mode & 0o022) !== 0) {
    throw new ProductionDatabaseResolutionError('production_database_env_file_unsafe');
  }

  const canonical = path.resolve(filePath);
  let real;
  try {
    real = realpathSync(filePath);
  } catch {
    throw new ProductionDatabaseResolutionError('production_database_env_file_unreadable');
  }
  if (real !== canonical) {
    throw new ProductionDatabaseResolutionError('production_database_env_file_unsafe');
  }

  let source;
  try {
    source = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    throw new ProductionDatabaseResolutionError('production_database_env_file_unreadable');
  }

  const values = [];
  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = parseDotenvValue(match[1]);
    if (POSTGRES_URI_PATTERN.test(value)) values.push(value);
  }
  return values;
}

export function productionProjectRef(raw, expectedProjectRef = PRODUCTION_PROJECT_REF) {
  let parsed;
  try {
    parsed = new URL(String(raw ?? '').trim());
  } catch {
    throw new ProductionDatabaseResolutionError('production_project_mismatch');
  }

  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) {
    throw new ProductionDatabaseResolutionError('production_project_mismatch');
  }
  if (!['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new ProductionDatabaseResolutionError('production_project_mismatch');
  }
  const match = /^([a-z0-9]+)\.supabase\.co$/i.exec(parsed.hostname);
  if (!match || match[1].toLowerCase() !== expectedProjectRef) {
    throw new ProductionDatabaseResolutionError('production_project_mismatch');
  }
  return match[1].toLowerCase();
}

export function productionDatabaseTarget(raw, projectRef) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProductionDatabaseResolutionError('production_database_project_mismatch', 1);
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new ProductionDatabaseResolutionError('production_database_project_mismatch', 1);
  }

  const hostname = parsed.hostname.toLowerCase();
  const username = decodeURIComponent(parsed.username);
  const usernameLower = username.toLowerCase();
  const direct = hostname === `db.${projectRef}.supabase.co` && usernameLower === 'postgres';
  const pooler = /(^|\.)pooler\.supabase\.com$/i.test(hostname)
    && usernameLower === `postgres.${projectRef}`;
  const database = decodeURIComponent(parsed.pathname.replace(/^\/+/, ''));
  const port = parsed.port || '5432';

  if ((!direct && !pooler) || !parsed.password || database !== 'postgres' || port !== '5432') {
    throw new ProductionDatabaseResolutionError('production_database_project_mismatch', 1);
  }

  return {
    hostname,
    port,
    username,
    password: decodeURIComponent(parsed.password),
    database,
    endpointType: direct ? 'direct' : 'pooler',
  };
}

export function collectProductionPostgresUris(runtime, options = {}) {
  const envFiles = options.envFiles ?? PRODUCTION_ENV_ALLOWLIST;
  const values = [];

  for (const value of Object.values(runtime ?? {})) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (POSTGRES_URI_PATTERN.test(trimmed)) values.push(trimmed);
  }

  for (const filePath of envFiles) {
    if (!PRODUCTION_ENV_ALLOWLIST.includes(filePath) && options.allowTestPaths !== true) {
      throw new ProductionDatabaseResolutionError('production_database_env_file_unsafe');
    }
    values.push(...readAllowedEnvValues(filePath));
  }

  return [...new Set(values)];
}

export function resolveProductionPostgresConnection(runtime, options = {}) {
  const projectRef = productionProjectRef(runtime?.SUPABASE_URL, options.expectedProjectRef ?? PRODUCTION_PROJECT_REF);
  const postgresUris = collectProductionPostgresUris(runtime, options);

  if (postgresUris.length === 0) {
    throw new ProductionDatabaseResolutionError('production_database_connection_missing', 0);
  }
  if (postgresUris.length !== 1) {
    throw new ProductionDatabaseResolutionError('production_database_connection_ambiguous', 2);
  }

  const database = productionDatabaseTarget(postgresUris[0], projectRef);
  return {
    projectRef,
    connectionCount: 1,
    database,
  };
}
