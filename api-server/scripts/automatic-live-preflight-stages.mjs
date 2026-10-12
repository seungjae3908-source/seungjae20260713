/** Run every independent offline check before returning failure. This collects
 * defects; it never changes a failed verdict, retries, or grants authority. */
export async function collectOfflinePreflightStages(stages) {
  if (!Array.isArray(stages) || stages.length === 0
    || stages.some((stage) => !/^[A-Za-z0-9_.:-]{1,160}$/u.test(stage?.id ?? '') || typeof stage.run !== 'function')
    || new Set(stages.map((stage) => stage.id)).size !== stages.length) {
    throw new Error('AUTO_LIVE_PREFLIGHT_STAGE_CONTRACT_INVALID');
  }
  const results = [];
  for (const stage of stages) {
    try {
      await stage.run();
      results.push({ id: stage.id, status: 'PASS', code: null });
    } catch {
      // Child test/build output retains the exact failure. The summary must
      // not reflect arbitrary exception text, filesystem paths or secrets.
      results.push({ id: stage.id, status: 'FAIL', code: 'AUTO_LIVE_OFFLINE_STAGE_FAILED' });
    }
  }
  return { ready: results.every((stage) => stage.status === 'PASS'), stages: results,
    productionActivationAttested: false, financialApiCalls: 0 };
}
