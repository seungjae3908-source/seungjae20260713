/** Poll metadata for the single returned run ID; never dispatch or rerun work. */
export async function waitForDispatchedAccountRun({ readRun, matches, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const run = await readRun();
    if (matches(run)) return run;
    if (attempt < 7) await delay(1000);
  }
  throw new Error('ACCOUNT_DISPATCH_EXACT_RUN_IDENTITY_NOT_CONFIRMED');
}
