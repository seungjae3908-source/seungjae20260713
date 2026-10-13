import path from 'node:path';
import { readContractSource } from './contract-source-text.mjs';
import { verifyAiPreviewDiagnosticContract } from './ai-preview-diagnostic-contract.mjs';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());

await verifyAiPreviewDiagnosticContract(relative => readContractSource(path.join(root, relative)));
console.log('[ai-preview-diagnostic-contract] authenticated browser request, query-aware route identity, positive pre-navigation GET abort classification, negative real-failure fallthrough, live evidence-only DB verification, safe diagnostics, sanitizer and raw-trace prohibition verified');
