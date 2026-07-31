import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const apiRoot = path.resolve(scriptDir, '..');
const repoRoot = path.resolve(apiRoot, '..');
const frontendRoot = path.join(repoRoot, 'stock-analyzer');
const results = [];

function loadEnvFile(filePath) {
  if (!existsSync(filePath)) return;
  const lines = readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, '\n');
  }
}

for (const file of [
  path.join(repoRoot, '.env'),
  path.join(repoRoot, '.env.production'),
  path.join(frontendRoot, '.env'),
  path.join(frontendRoot, '.env.production'),
]) {
  loadEnvFile(file);
}

function add(name, status, detail = null) {
  results.push({ name, status, detail });
}

async function run(command, args, options = {}) {
  return execFileAsync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: process.env,
    timeout: options.timeout ?? 20_000,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true,
  });
}

async function fetchJson(url, init = {}, timeoutMs = 8_000) {
  const response = await fetch(url, {
    ...init,
    headers: {
      Accept: 'application/json',
      'Cache-Control': 'no-cache',
      ...(init.headers ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

function normalizeUrl(value) {
  return String(value ?? '').trim().replace(/\/$/, '');
}

function internalEmail(loginName) {
  const normalized = String(loginName).trim().normalize('NFKC').toLowerCase();
  const token = createHash('sha256')
    .update(`seungjae-stock-account:${normalized}`)
    .digest()
    .subarray(0, 20)
    .toString('hex');
  return `${token}@accounts.seungjae-stock.com`;
}

function listFiles(root, suffix) {
  if (!existsSync(root)) return [];
  const output = [];
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const name of readdirSync(current)) {
      const fullPath = path.join(current, name);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) stack.push(fullPath);
      else if (fullPath.endsWith(suffix)) output.push(fullPath);
    }
  }
  return output;
}

async function main() {
  const expectedSha = String(
    process.env.STOCKDEPLOY_EXPECTED_SHA ?? process.argv[2] ?? '',
  ).trim();
  const publicUrl = normalizeUrl(
    process.env.STOCKDEPLOY_PUBLIC_URL ?? 'https://lsj119.duckdns.org',
  );
  const supabaseUrl = normalizeUrl(
    process.env.VITE_SUPABASE_URL ?? process.env.SUPABASE_URL,
  );
  const anonKey = String(
    process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY ?? '',
  ).trim();

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  add('node_version', nodeMajor >= 20 ? 'pass' : 'fail', process.versions.node);

  try {
    const { stdout } = await run('git', ['rev-parse', 'HEAD']);
    const head = stdout.trim();
    if (expectedSha && head !== expectedSha) {
      add('git_head', 'fail', { expected: expectedSha, actual: head });
    } else {
      add('git_head', 'pass', { actual: head, expected: expectedSha || null });
    }
  } catch (cause) {
    add('git_head', 'fail', cause instanceof Error ? cause.message : String(cause));
  }

  try {
    const { stdout } = await run('git', ['status', '--porcelain=v1']);
    const dirty = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const allowed = dirty.filter((line) =>
      /(?:api-server\/dist|stock-analyzer\/dist\/public)\//.test(line),
    );
    const unexpected = dirty.filter((line) => !allowed.includes(line));
    add('working_tree', unexpected.length === 0 ? 'pass' : 'fail', {
      unexpected,
      generatedBuildFiles: allowed.length,
    });
  } catch (cause) {
    add('working_tree', 'fail', cause instanceof Error ? cause.message : String(cause));
  }

  try {
    const { stdout } = await run('df', ['-Pk', repoRoot]);
    const lines = stdout.trim().split(/\r?\n/);
    const columns = lines.at(-1)?.trim().split(/\s+/) ?? [];
    const usedPercent = Number(String(columns[4] ?? '').replace('%', ''));
    add('disk_space', usedPercent < 92 ? 'pass' : 'fail', {
      usedPercent: Number.isFinite(usedPercent) ? usedPercent : null,
      blockAtPercent: 92,
    });
  } catch (cause) {
    add('disk_space', 'fail', cause instanceof Error ? cause.message : String(cause));
  }

  try {
    const { stdout } = await run('pm2', ['jlist']);
    const rows = JSON.parse(stdout);
    const onlineWorkers = Array.isArray(rows)
      ? rows
          .filter((row) => {
            const name = String(row?.name ?? '');
            const status = String(row?.pm2_env?.status ?? '');
            return /(?:signal|alert).*worker|worker.*(?:signal|alert)/i.test(name) && status === 'online';
          })
          .map((row) => String(row?.name ?? ''))
      : ['PM2_JLIST_INVALID'];
    add('order_worker_lock', onlineWorkers.length === 0 ? 'pass' : 'fail', {
      onlineWorkers,
    });
  } catch (cause) {
    add('order_worker_lock', 'fail', cause instanceof Error ? cause.message : String(cause));
  }

  if (!supabaseUrl || !anonKey) {
    add('supabase_environment', 'fail', {
      urlConfigured: Boolean(supabaseUrl),
      anonKeyConfigured: Boolean(anonKey),
    });
  } else {
    try {
      const parsed = new URL(supabaseUrl);
      if (parsed.protocol !== 'https:') throw new Error('SUPABASE_URL_MUST_USE_HTTPS');
      add('supabase_environment', 'pass', { host: parsed.host });
    } catch (cause) {
      add('supabase_environment', 'fail', cause instanceof Error ? cause.message : String(cause));
    }

    try {
      const { response } = await fetchJson(`${supabaseUrl}/auth/v1/health`, {
        headers: { apikey: anonKey },
      });
      add('supabase_auth_health', response.ok ? 'pass' : 'fail', {
        status: response.status,
      });
    } catch (cause) {
      add('supabase_auth_health', 'fail', cause instanceof Error ? cause.message : String(cause));
    }

    try {
      const { response } = await fetchJson(`${supabaseUrl}/auth/v1/settings`, {
        headers: { apikey: anonKey },
      });
      add('supabase_auth_settings', response.ok ? 'pass' : 'fail', {
        status: response.status,
      });
    } catch (cause) {
      add('supabase_auth_settings', 'fail', cause instanceof Error ? cause.message : String(cause));
    }

    const loginName = String(process.env.STOCKDEPLOY_TEST_LOGIN_NAME ?? '').trim();
    const password = String(process.env.STOCKDEPLOY_TEST_PASSWORD ?? '');
    if (loginName && password) {
      try {
        const { response, body } = await fetchJson(
          `${supabaseUrl}/auth/v1/token?grant_type=password`,
          {
            method: 'POST',
            headers: {
              apikey: anonKey,
              Authorization: `Bearer ${anonKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              email: internalEmail(loginName),
              password,
            }),
          },
          12_000,
        );
        add(
          'supabase_login_smoke',
          response.ok && typeof body?.access_token === 'string' ? 'pass' : 'fail',
          { status: response.status },
        );
      } catch (cause) {
        add('supabase_login_smoke', 'fail', cause instanceof Error ? cause.message : String(cause));
      }
    } else {
      add('supabase_login_smoke', 'warn', 'TEST_CREDENTIALS_NOT_CONFIGURED');
    }
  }

  if (publicUrl) {
    try {
      const { response, body } = await fetchJson(`${publicUrl}/api/health`, {}, 10_000);
      add('public_api_health', response.ok ? 'pass' : 'fail', {
        status: response.status,
        commitSha: body?.commitSha ?? body?.build?.commitSha ?? null,
      });
    } catch (cause) {
      add('public_api_health', 'fail', cause instanceof Error ? cause.message : String(cause));
    }
  }

  const bundleRoot = path.join(frontendRoot, 'dist', 'public');
  const builtScripts = listFiles(bundleRoot, '.js');
  if (builtScripts.length > 0 && supabaseUrl) {
    const containsUrl = builtScripts.some((file) =>
      readFileSync(file, 'utf8').includes(supabaseUrl),
    );
    const containsUnreplacedVariable = builtScripts.some((file) =>
      /VITE_SUPABASE_(?:URL|ANON_KEY)/.test(readFileSync(file, 'utf8')),
    );
    add('frontend_supabase_bundle', containsUrl && !containsUnreplacedVariable ? 'pass' : 'fail', {
      scriptsChecked: builtScripts.length,
      containsConfiguredUrl: containsUrl,
      containsUnreplacedVariable,
    });
  } else {
    add('frontend_supabase_bundle', 'warn', 'FRONTEND_BUILD_NOT_FOUND');
  }

  const failed = results.filter((row) => row.status === 'fail');
  const warned = results.filter((row) => row.status === 'warn');
  const summary = {
    event: 'stockdeploy_preflight',
    ok: failed.length === 0,
    failed: failed.map((row) => row.name),
    warned: warned.map((row) => row.name),
    results,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

await main();
