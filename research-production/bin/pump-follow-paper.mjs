#!/usr/bin/env node
// Pump-follow forward paper ledger tick (research only, no orders).
//   node research-production/bin/pump-follow-paper.mjs [stateRoot]
import { resolve } from 'node:path';

import { formatPumpFollowPaperKoV1, runPumpFollowPaperV1 } from '../src/pump-follow-paper-v1.mjs';

const root = resolve(process.argv[2] ?? process.env.RESEARCH_STATE_ROOT ?? '/var/lib/investment-research-production');
const result = await runPumpFollowPaperV1({ stateRoot: root });
process.stdout.write(`${formatPumpFollowPaperKoV1(result)}\n`);
