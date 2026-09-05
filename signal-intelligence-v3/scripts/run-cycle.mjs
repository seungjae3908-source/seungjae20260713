import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { runSignalIntelligenceV3, assertSignalIntelligenceV3Snapshot } from '../src/engine.mjs';
import { toCanonicalTelegramAlert } from '../src/telegram-events.mjs';

function args(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith('--')) continue;
    const value = argv[index + 1];
    out[key.slice(2)] = value && !value.startsWith('--') ? argv[++index] : true;
  }
  return out;
}

async function json(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'));
}

const cli = args(process.argv.slice(2));
if (!cli.input || !cli.output) {
  console.error('usage: node run-cycle.mjs --input candidates.json --output snapshot.json [--previous previous.json] [--telegram-events telegram.json]');
  process.exit(2);
}

const payload = await json(cli.input);
const candidates = Array.isArray(payload) ? payload : payload.candidates;
if (!Array.isArray(candidates)) throw new TypeError('input must be an array or { candidates: [] }');
const previousSnapshot = cli.previous ? await json(cli.previous) : null;
const snapshot = runSignalIntelligenceV3(candidates, {
  previousSnapshot,
  maxCandidatesPerList: Number(payload.maxCandidatesPerList) || undefined,
  futuresDirectionSeparationMinR: Number.isFinite(Number(payload.futuresDirectionSeparationMinR))
    ? Number(payload.futuresDirectionSeparationMinR)
    : undefined,
});
assertSignalIntelligenceV3Snapshot(snapshot);
await writeFile(resolve(cli.output), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');

if (cli['telegram-events']) {
  const telegram = snapshot.events.map((event) => ({
    room: ['KR_STOCK', 'US_STOCK'].includes(event.market) ? 'STOCK_ROOM' : 'CRYPTO_ROOM',
    alert: toCanonicalTelegramAlert(event, (room) => `__${room}__`),
  }));
  await writeFile(resolve(cli['telegram-events']), `${JSON.stringify(telegram, null, 2)}\n`, 'utf8');
}

console.log(JSON.stringify({
  ok: true,
  output: resolve(cli.output),
  candidateCounts: Object.fromEntries(Object.entries(snapshot.lists).map(([key, rows]) => [key, rows.length])),
  events: snapshot.events.length,
  executionAuthority: snapshot.safety.executionAuthority,
}, null, 2));
