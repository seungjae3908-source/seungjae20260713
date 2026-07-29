import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { verifyLiveCollection } from "../src/live-collection-verifier.js";

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`missing value for --${name}`);
    values[name] = value;
    index += 1;
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
if (!args.input) throw new Error("--input is required");
const inputPath = resolve(args.input);
const reportPath = resolve(args.report ?? `${inputPath}.quality.json`);
const minCandles = Number(args["min-candles"] ?? 60);
const snapshot = JSON.parse(await readFile(inputPath, "utf8"));
const report = verifyLiveCollection(snapshot, { minCandles });
await mkdir(dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ inputPath, reportPath, ...report }, null, 2));
