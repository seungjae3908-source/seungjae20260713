import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  ResearchDualFreeAiError,
  runResearchDualFreeAiReview,
  type ResearchFreeAiProvider,
  type ResearchFreeAiRole,
} from '../src/services/research-dual-free-ai.service';

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`missing required argument ${name}`);
  return String(process.argv[index + 1]);
}

function providerFrom(value: string): ResearchFreeAiProvider {
  if (value === 'gemini' || value === 'groq') return value;
  throw new Error('provider must be gemini or groq');
}

function roleFrom(value: string): ResearchFreeAiRole {
  if (value === 'PROPOSER' || value === 'CRITIC') return value;
  throw new Error('role must be PROPOSER or CRITIC');
}

function isolateProviderEnvironment(provider: ResearchFreeAiProvider): void {
  delete process.env.AI_CHAT_API_KEY;
  delete process.env.AI_CHAT_MODEL;
  delete process.env.OPENAI_API_KEY;
  process.env.AI_CHAT_PROVIDER = provider;

  if (provider === 'gemini') {
    delete process.env.GROQ_API_KEY;
    delete process.env.GROQ_MODEL;
    if (!process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) {
      throw new ResearchDualFreeAiError('MISCONFIGURED', 'Gemini free provider credential is unavailable');
    }
    return;
  }

  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_API_KEY;
  delete process.env.GEMINI_MODEL;
  if (!process.env.GROQ_API_KEY) {
    throw new ResearchDualFreeAiError('MISCONFIGURED', 'Groq free provider credential is unavailable');
  }
}

async function main(): Promise<void> {
  const provider = providerFrom(argument('--provider'));
  const role = roleFrom(argument('--role'));
  const inputPath = resolve(argument('--input'));
  isolateProviderEnvironment(provider);

  const raw = JSON.parse(await readFile(inputPath, 'utf8')) as Record<string, unknown>;
  const result = await runResearchDualFreeAiReview({
    provider,
    role,
    promptVersion: String(raw.promptVersion ?? ''),
    evidenceDigest: String(raw.evidenceDigest ?? ''),
    evidenceSummary: String(raw.evidenceSummary ?? ''),
  });

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((cause: unknown) => {
  const safe = cause instanceof ResearchDualFreeAiError
    ? { status: 'UNAVAILABLE', code: cause.code, message: cause.message, executionAuthority: 'NONE', orderAllowed: false, paidFallback: false }
    : { status: 'UNAVAILABLE', code: 'RUNNER_FAILED', message: 'research dual-free-ai runner failed', executionAuthority: 'NONE', orderAllowed: false, paidFallback: false };
  process.stderr.write(`${JSON.stringify(safe)}\n`);
  process.exitCode = 1;
});
