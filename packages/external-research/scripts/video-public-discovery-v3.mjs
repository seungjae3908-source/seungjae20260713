#!/usr/bin/env node
import { runPublicVideoDiscoveryV3 } from '../src/video-intelligence-phase3-runtime.js';

const argvQuery = process.argv.slice(2).join(' ').trim();
const envQuery = typeof process.env.VIDEO_RESEARCH_QUERY === 'string' ? process.env.VIDEO_RESEARCH_QUERY.trim() : '';
const query = argvQuery || envQuery || 'bitcoin technical analysis strategy';

const result = await runPublicVideoDiscoveryV3({
  query,
  maxResults: 3,
  maxPages: 1,
  discoveryReason: 'PHASE3_PUBLIC_PROVIDER_RUNTIME_READ_ONLY',
  economicEvidenceCredit: 0,
  profitabilityCredit: 0,
  executionAuthority: 'NONE',
  paidProviderEnabled: false,
  scheduleActive: false,
  automaticDiscoveryEnabled: false,
  liveTrading: false,
  privateTradingApi: false,
  realOrderEnabled: false,
  credentialMutation: false,
  transcriptDownloadEnabled: false,
});

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== 'SUCCESS') process.exitCode = 2;
