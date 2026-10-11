// Process-wide start-rate guard for this Scanner's public provider traffic.
// It cannot certify an exchange-wide IP budget shared with other processes.
export class CryptoPublicRequestGate {
  private nextAt = 0;
  private blockedUntil = 0;
  constructor(private readonly spacingMs: number) {}

  backoff(milliseconds: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, Date.now() + Math.max(0, milliseconds));
  }

  async admit(signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) throw signal.reason ?? new Error('CRYPTO_PROVIDER_ABORTED');
      const now = Date.now();
      const delay = Math.max(this.nextAt, this.blockedUntil) - now;
      if (delay <= 0) {
        this.nextAt = now + this.spacingMs;
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => signal.removeEventListener('abort', abort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, delay);
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason ?? new Error('CRYPTO_PROVIDER_ABORTED')); };
        signal.addEventListener('abort', abort, { once: true });
      });
      // Recheck after waiting: concurrent waiters and a new 429 cannot steal
      // the same slot or bypass the shared cooldown.
    }
  }
}
