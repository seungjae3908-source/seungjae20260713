import { spawn } from 'node:child_process';
import path from 'node:path';

const allowedConfigs = new Set([
  'vite.config.ts',
  'vite.research-workspace.config.ts',
]);

const config = process.argv[2] ?? 'vite.config.ts';
const localPort = Number(process.env.APP_E2E_PORT ?? 4173);
if (!Number.isInteger(localPort) || localPort < 1024 || localPort > 65535) throw new Error('Invalid APP_E2E_PORT');

if (!allowedConfigs.has(config)) {
  console.error(`Unsupported E2E Vite config: ${config}`);
  process.exit(1);
}

const viteCli = path.join(
  process.cwd(),
  'node_modules', 'vite', 'bin', 'vite.js',
);

const child = spawn(
  process.execPath,
  [viteCli, '--config', config, '--host', '127.0.0.1', '--port', String(localPort), '--strictPort'],
  {
    env: {
      ...process.env,
      VITE_SUPABASE_URL: `http://127.0.0.1:${localPort}/__e2e-supabase`,
      VITE_SUPABASE_ANON_KEY: 'e2e-public-anon-key',
      VITE_PHASE4_E2E: 'true',
      VITE_PHASE5_E2E: 'true',
      VITE_PHASE6_E2E: 'true',
      VITE_PHASE7_E2E: 'true',
      VITE_PHASE8_E2E: 'true',
      VITE_PHASE9_E2E: 'true',
      VITE_PHASE11_E2E: 'true',
      VITE_PHASE12_E2E: 'true',
    },
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  console.error('Unable to start the E2E Vite server:', error);
  process.exit(1);
});

child.once('exit', (code) => {
  process.exit(code ?? 1);
});

const stop = () => child.kill();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
