import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const componentPath = fileURLToPath(new URL('../src/components/member-privacy-watermark.tsx', import.meta.url));
const backgroundPath = fileURLToPath(new URL('../src/components/app-background.tsx', import.meta.url));

test('member watermark is anonymous, non-interactive, and mounted globally', async () => {
  const [component, background] = await Promise.all([
    readFile(componentPath, 'utf8'),
    readFile(backgroundPath, 'utf8'),
  ]);

  expect(component).toContain("digest(\n    'SHA-256'");
  expect(component).toContain('member-privacy-watermark-v1:');
  expect(component).toContain('slice(0, 6)');
  expect(component).toContain('pointer-events-none');
  expect(component).toContain('select-none');
  expect(component).toContain('fixed inset-0');
  expect(component).toContain('WATERMARK_COPIES = 30');
  expect(component).toContain('보호화면 · {memberCode} · {minute}');
  expect(component).toContain('if (!userId || !isApproved)');

  // The visible watermark must never render raw account identifiers or contact data.
  expect(component).not.toContain('>{user.id}<');
  expect(component).not.toContain('{user.email}');
  expect(component).not.toContain('{profile.login_name}');
  expect(component).not.toContain('{displayName}');
  expect(component).not.toContain('phone');

  // It must live outside the z-0 background so the watermark remains visible over app content.
  expect(background).toContain("import { MemberPrivacyWatermark }");
  expect(background).toContain('<MemberPrivacyWatermark />');
});

test('web watermark does not falsely claim native screenshot blocking', async () => {
  const component = await readFile(componentPath, 'utf8');
  expect(component).not.toMatch(/FLAG_SECURE|preventScreenshot|disableScreenshot|screenshotBlocked/u);
  expect(component).not.toMatch(/캡처\s*차단|스크린샷\s*차단/u);
});
