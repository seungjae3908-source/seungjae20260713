import path from 'node:path';
import { readContractSource } from './contract-source-text.mjs';
import { verifyStagingDetailCanonicalRouteContract } from './staging-detail-canonical-route-contract.mjs';

const root = path.basename(process.cwd()) === 'api-server'
  ? path.resolve(process.cwd(), '..')
  : path.resolve(process.cwd());

await verifyStagingDetailCanonicalRouteContract(relative => readContractSource(path.join(root, relative)));
console.log('[staging-detail-canonical-route-contract] legacy bare-detail entry is required to reach the exact shared /stock-info canonical destination');
