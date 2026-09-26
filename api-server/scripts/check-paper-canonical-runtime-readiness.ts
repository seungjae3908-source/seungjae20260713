import { probeManualPaperCanonicalRuntimeReadiness } from '../src/services/manual-paper-canonical-runtime-readiness.service';

function expectedMainSha(): string {
  const fromArgument = process.argv
    .slice(2)
    .find((value) => value.startsWith('--expected-main-sha='))
    ?.slice('--expected-main-sha='.length)
    .trim()
    .toLowerCase();
  return fromArgument || String(process.env.EXPECTED_MAIN_SHA ?? '').trim().toLowerCase();
}

const result = await probeManualPaperCanonicalRuntimeReadiness({
  expectedMainSha: expectedMainSha(),
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

if (!result.readyForActivationReview) {
  process.exitCode = 2;
}
