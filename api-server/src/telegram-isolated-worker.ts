/** Dormant standalone Telegram-only worker. A verified external flock owner must launch it.
 * No HTTP listener, trading/recovery worker, provider-private client or order runner.
 */
import {
  assertIsolatedTelegramWorkerEnvironment,
} from './lib/telegram-worker-ownership';

async function main() {
  try {
    assertIsolatedTelegramWorkerEnvironment();
  } catch (error) {
    const code = error instanceof Error ? error.message : 'TELEGRAM_ISOLATED_PREFLIGHT_FAILED';
    console.error('[telegram-isolated] blocked', { code });
    process.exitCode = 14;
    return;
  }
  // No worker import or side effect before checking lease and financial boundary.
  const [{ startUserTelegramDeliveryWorker },
    { startTelegramIntelligenceWorker },
    { startSignalIntelligenceTelegramSubscriber }] = await Promise.all([
    import('./features/user-broker-telegram/user-broker-telegram.worker'),
    import('./services/telegram-intelligence-worker.service'),
    import('./services/signal-intelligence-telegram-subscriber.service'),
  ]);
  const personal = startUserTelegramDeliveryWorker();
  const briefing = startTelegramIntelligenceWorker();
  const signal = startSignalIntelligenceTelegramSubscriber();
  if (!personal || !briefing || !signal) {
    personal?.stop();
    briefing?.stop();
    signal?.stop();
    console.error('[telegram-isolated] required lane unavailable; send readiness not proven');
    process.exitCode = 15;
    return;
  }
  console.log('[telegram-isolated] three lanes started; no Bot acceptance implied');
  // Existing worker timers are deliberately unref'd for the embedded server.
  // Standalone must retain one referenced handle for its entire lifetime.
  const keepAlive = setInterval(() => {}, 60_000);
  let draining = false;
  const shutdown = (signalName: string) => {
    if (draining) return;
    draining = true;
    clearInterval(keepAlive);
    personal.stop();
    briefing.stop();
    signal.stop();
    console.log('[telegram-isolated] no new ticks scheduled', { signalName });
    // Give in-flight sends time to finish. Ambiguous outcomes stay reserved in
    // the shared durable ledgers rather than automatically re-sending.
    setTimeout(() => { process.exitCode = 0; process.exit(); }, 75_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}
void main().catch((error) => {
  console.error('[telegram-isolated] startup failed', {
    code: error instanceof Error && /^[A-Z0-9_]+$/u.test(error.message)
      ? error.message : 'TELEGRAM_ISOLATED_STARTUP_FAILED',
  });
  process.exitCode = 16;
});
