import { ingestSnapshotFile } from "../src/snapshot-store.js";

function parseArgs(args) {
  const result = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!key?.startsWith("--") || args[index + 1] === undefined) throw new Error(`invalid argument near: ${key}`);
    result[key.slice(2)] = args[index + 1];
  }
  return result;
}

const args = parseArgs(process.argv.slice(2));
for (const required of ["input", "output", "market", "symbol", "timeframe", "format"]) if (!args[required]) throw new Error(`--${required} is required`);
const result = await ingestSnapshotFile(args.input, args.output, {
  market: args.market,
  symbol: args.symbol,
  timeframe: args.timeframe,
  format: args.format,
  timestampUnit: args.timestampUnit ?? "auto",
  source: args.source ?? "offline-import",
  rowsPath: args.rowsPath,
  strict: args.strict !== "false",
});
console.log(JSON.stringify(result.manifest, null, 2));
