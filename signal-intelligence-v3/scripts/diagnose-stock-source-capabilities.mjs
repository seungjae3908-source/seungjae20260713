// Keep this script independent from build/browser/data collectors. No
// provider credentials or secrets. Never declare market readiness from a probe.
import {probePublicStockSources} from '../src/public-stock-source-capabilities.mjs';
const report=await probePublicStockSources();
console.log(JSON.stringify(report,null,2));
