import { expect, test } from '@playwright/test';

const VIEWPORTS = [320, 768, 1280, 1920] as const;

for (const width of VIEWPORTS) {
  test(`large patch shell remains readable and unobstructed at ${width}px`, async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.goto('/__phase11-unified-search-e2e');

    await expect(page.getByRole('heading', { name: '종목', level: 1 })).toBeVisible();
    await expect(page.getByRole('combobox', { name: '통합 자산 검색' })).toHaveCount(1);
    const navigation = page.getByRole('navigation', { name: '주요 메뉴' });
    await expect(navigation).toBeVisible();

    const overflow = await page.evaluate(() => ({
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: document.documentElement.clientWidth,
      bodyWidth: document.body.scrollWidth,
    }));
    expect(overflow.documentWidth, 'document horizontal overflow').toBeLessThanOrEqual(overflow.viewportWidth + 1);
    expect(overflow.bodyWidth, 'body horizontal overflow').toBeLessThanOrEqual(overflow.viewportWidth + 1);

    const labelLayout = await navigation.locator('button > span:last-child').evaluateAll((nodes) => nodes.map((node) => {
      const element = node as HTMLElement;
      const style = getComputedStyle(element);
      return {
        text: element.textContent ?? '',
        whiteSpace: style.whiteSpace,
        height: element.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(style.lineHeight),
      };
    }));
    for (const label of labelLayout) {
      expect(label.whiteSpace, `${label.text}: navigation label must not wrap character-by-character`).toBe('nowrap');
      if (Number.isFinite(label.lineHeight) && label.lineHeight > 0) {
        expect(label.height, `${label.text}: navigation label rendered on multiple lines`).toBeLessThanOrEqual(label.lineHeight * 1.25);
      }
    }

    const main = page.locator('main');
    await main.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    const lastAction = page.getByRole('button', { name: /시장 순위 보기/ });
    const lastBox = await lastAction.boundingBox();
    const navBox = await navigation.boundingBox();
    expect(lastBox, 'last action must be measurable').not.toBeNull();
    expect(navBox, 'bottom navigation must be measurable').not.toBeNull();
    expect((lastBox?.y ?? 0) + (lastBox?.height ?? 0), 'last content is hidden behind BottomNav')
      .toBeLessThanOrEqual((navBox?.y ?? 0) + 1);

    const scrollOwners = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('body, main, [class*="overflow-y-auto"]'));
      return candidates.filter((element) => {
        const style = getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 2;
      }).map((element) => ({ tag: element.tagName, className: element.className, scrollHeight: element.scrollHeight, clientHeight: element.clientHeight }));
    });
    expect(scrollOwners.length, `nested vertical scroll owners: ${JSON.stringify(scrollOwners)}`).toBeLessThanOrEqual(1);

    expect(consoleErrors, consoleErrors.join('\n')).toEqual([]);
    expect(pageErrors, pageErrors.join('\n')).toEqual([]);
  });
}
