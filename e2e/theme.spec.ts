import { expect, test } from '@playwright/test';
import { login, workspaceBase } from './helpers';
test.use({ colorScheme: 'dark' });
test('light mode is fully light even when the Mac is in dark mode; dark mode is fully dark', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  const base = await workspaceBase(page);
  await page.getByRole('button', { name: /E2E Owner/ }).click();
  await page.getByTestId('theme-toggle').getByRole('button', { name: 'Light' }).click();
  await page.keyboard.press('Escape');
  await page.locator('main h1').first().click(); // close the menu by clicking somewhere inert (not a fixed position)
  await page.waitForTimeout(300);
  const lum = (sel: string) => page.locator(sel).first().evaluate((el) => { const m = getComputedStyle(el).backgroundColor.match(/\d+/g)!.map(Number); return (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255; });
  for (const sel of ['body', 'aside', 'header', '[data-testid="today-flow"]', '.card']) expect(await lum(sel), `${sel} should be light`).toBeGreaterThan(0.85);
  await page.reload(); await page.waitForLoadState('networkidle');
  expect(await lum('aside')).toBeGreaterThan(0.85);
  await page.goto(`${base}/settings/account`);
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  for (const sel of ['body', 'aside', 'header', '.card']) expect(await lum(sel), `${sel} should be dark`).toBeLessThan(0.2);
  await page.goto(base); await page.waitForLoadState('networkidle');
  expect(await lum('[data-testid="today-flow"]')).toBeLessThan(0.2);
});
