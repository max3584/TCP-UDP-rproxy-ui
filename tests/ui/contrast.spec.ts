// ライト・ダークのどちらでも、白地に白文字のような読めない文字がないこと
import { expect, test } from '@playwright/test';

const PAGES = ['/', '/rules/new', '/profile'];

for (const colorScheme of ['light', 'dark'] as const) {
  test.describe(`${colorScheme} mode`, () => {
    test.use({ colorScheme });
    for (const path of PAGES) {
      test(`no white-on-white text on ${path}`, async ({ page }) => {
        await page.goto(path);
        await page.waitForLoadState('networkidle');
        const unreadable = await page.evaluate(() => {
          const bgOf = (el: Element | null): string => {
            for (let e = el; e; e = e.parentElement) {
              const bg = getComputedStyle(e).backgroundColor;
              if (bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
            }
            return getComputedStyle(document.body).backgroundColor;
          };
          return [...document.querySelectorAll('body *')]
            .filter((e) => {
              const s = getComputedStyle(e);
              if (s.display === 'none' || s.visibility === 'hidden') return false;
              const hasText = [...e.childNodes].some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
              return hasText && s.color === bgOf(e);
            })
            .map((e) => `${e.tagName.toLowerCase()}: ${e.textContent?.trim().slice(0, 40)}`);
        });
        expect(unreadable).toEqual([]);
      });
    }
  });
}
