import { spawn } from 'node:child_process';
import path from 'node:path';

const allowedConfigs = new Set(['vite.preview.config.ts']);
const config = process.argv[2] ?? 'vite.preview.config.ts';
const port = Number(process.env.PREVIEW_PORT ?? 5174);
if (!Number.isSafeInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid preview port');
if (!allowedConfigs.has(config)) {
  console.error(`Unsupported preview Vite config: ${config}`);
  process.exit(1);
}

const viteCli = path.join(process.cwd(), 'node_modules', 'vite', 'bin', 'vite.js');

const child = spawn(
  process.execPath,
  [viteCli, '--config', config, '--host', '127.0.0.1', '--port', String(port), '--strictPort'],
  {
    env: {
      ...process.env,
      VITE_UI_PREVIEW: 'true',
      // 실거래 안전 정책은 Preview에서도 그대로 유지한다.
      LIVE_TRADING: 'false',
      AUTO_TRADING: 'false',
      REAL_ORDER_ENABLED: 'false',
      PRIVATE_TRADING_API_ALLOWED: 'false',
    },
    stdio: 'inherit',
  },
);

child.once('error', (error) => {
  console.error('Unable to start the preview Vite server:', error);
  process.exit(1);
});
child.once('exit', (code) => process.exit(code ?? 1));

const stop = () => child.kill();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
