import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveAppRoutePresentation } from '../src/lib/app-navigation';

type Finding = {
  kind: string;
  file: string;
  line: number;
  text: string;
};

const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const PRODUCT_ROOT = path.resolve(process.cwd(), 'src');
const UI_PR_OWNED_FILES = new Set([
  'src/components/bottom-nav.tsx',
  'src/lib/app-navigation.ts',
]);

const patterns: Array<{ kind: string; expression: RegExp }> = [
  {
    kind: 'empty-onclick',
    expression: /onClick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/g,
  },
  {
    kind: 'hash-only-href',
    expression: /href\s*=\s*["']#["']/g,
  },
  {
    kind: 'temporary-alert',
    expression: /\b(?:window\.)?alert\s*\(/g,
  },
  {
    kind: 'console-log',
    expression: /\bconsole\.log\s*\(/g,
  },
  {
    kind: 'constant-false-render',
    expression: /\{\s*false\s*&&/g,
  },
];

function collectFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectFiles(absolute);
    return SOURCE_EXTENSIONS.has(path.extname(entry.name)) ? [absolute] : [];
  });
}

function lineNumber(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}

function lineText(source: string, line: number): string {
  return source.split('\n')[line - 1]?.trim().slice(0, 240) ?? '';
}

function normalizedFile(absolute: string): string {
  return path.relative(process.cwd(), absolute).split(path.sep).join('/');
}

function scanPatterns(file: string, source: string): Finding[] {
  const relative = normalizedFile(file);
  return patterns.flatMap(({ kind, expression }) => {
    expression.lastIndex = 0;
    return [...source.matchAll(expression)].map((match) => {
      const line = lineNumber(source, match.index ?? 0);
      return { kind, file: relative, line, text: lineText(source, line) };
    });
  });
}

function scanStaticRoutes(file: string, source: string): Finding[] {
  const relative = normalizedFile(file);
  const expression = /(?:navigate\s*\(|href\s*=\s*|to\s*=\s*)["'](\/[A-Za-z0-9_./:-]+)["']/g;
  return [...source.matchAll(expression)].flatMap((match) => {
    const target = match[1];
    if (!target || resolveAppRoutePresentation(target)) return [];
    const line = lineNumber(source, match.index ?? 0);
    return [{
      kind: 'unresolved-static-route',
      file: relative,
      line,
      text: `${target} :: ${lineText(source, line)}`,
    }];
  });
}

test('UI source static audit records dummy handlers, dead branches, and unresolved literal routes', async ({}, testInfo) => {
  const files = collectFiles(PRODUCT_ROOT);
  const findings = files.flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return [...scanPatterns(file, source), ...scanStaticRoutes(file, source)];
  });

  const summary = findings.reduce<Record<string, number>>((counts, finding) => {
    counts[finding.kind] = (counts[finding.kind] ?? 0) + 1;
    return counts;
  }, {});

  const report = {
    scannedFiles: files.length,
    summary,
    findings,
  };

  await testInfo.attach('ui-static-audit.json', {
    body: Buffer.from(JSON.stringify(report, null, 2)),
    contentType: 'application/json',
  });

  console.log(`UI_STATIC_AUDIT=${JSON.stringify(report)}`);

  const ownedBlockingFindings = findings.filter((finding) =>
    UI_PR_OWNED_FILES.has(finding.file) &&
    ['empty-onclick', 'hash-only-href', 'temporary-alert', 'console-log', 'unresolved-static-route'].includes(finding.kind),
  );

  expect(ownedBlockingFindings).toEqual([]);
});
