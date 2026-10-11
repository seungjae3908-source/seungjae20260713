#!/usr/bin/env node
// Bounded first-party PUBLIC GET probe only: official Upbit/Bitget market
// snapshots, no keys, account access, DB, orders, live or Paper activation.
// Output is counts/hashes ONLY; no raw provider response or symbol list.
import {probePublicCryptoAllVenues} from '../src/public-crypto-all-venue-coverage.mjs';
const report=await probePublicCryptoAllVenues();
process.stdout.write(JSON.stringify(report,null,2)+'\n');
