import {
  preparePublicForwardPartialFillRuntimeLocatorActivation,
} from '../services/public-forward-partial-fill-calibration-runtime-locator-activation.service';

function usage(): string {
  return [
    'Usage:',
    '  node prepare-public-forward-partial-fill-runtime-locator-activation.cjs \\',
    '    --state-root <absolute-state-root> \\',
    '    --release-binding-ref <immutable-relative-ref> \\',
    '    --release-binding-digest <64-hex> \\',
    '    --runtime-release-sha <40-hex>',
    '',
    'This command is read-only. It verifies the immutable binding chain and prints a locator activation preflight plan.',
    'It does not mutate environment variables, restart services, deploy code, publish bindings, or activate runtime.',
  ].join('\n');
}

function parseArgs(argv: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--help' || token === '-h') {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (!token.startsWith('--')) throw new Error(`UNEXPECTED_ARGUMENT:${token}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`MISSING_ARGUMENT_VALUE:${token}`);
    values[token.slice(2)] = value;
    index += 1;
  }
  return values;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const required = [
    'state-root',
    'release-binding-ref',
    'release-binding-digest',
    'runtime-release-sha',
  ];
  for (const name of required) {
    if (!args[name]?.trim()) throw new Error(`MISSING_ARGUMENT:${name}`);
  }

  const result = await preparePublicForwardPartialFillRuntimeLocatorActivation({
    stateRoot: args['state-root'],
    releaseBindingRef: args['release-binding-ref'],
    releaseBindingDigest: args['release-binding-digest'],
    runtimeReleaseSha: args['runtime-release-sha'],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
