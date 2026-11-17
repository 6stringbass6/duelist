import { test, expect } from '@playwright/test';
const { E2E_USER, E2E_PASS, DEV_SECRET_CODE } = process.env;
test.describe('배포 스모크: 로그인 → 상점 → 개발자 패널 계정 스킨 조회', () => {
  test.skip(!E2E_USER || !E2E_PASS, 'E2E_USER / E2E_PASS 필요 (.env.local)');
  test('flow', async ({ page }) => {
    const errors: string[] = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await page.fill('#auth-id', E2E_USER!); await page.fill('#auth-pw', E2E_PASS!); await page.click('#auth-submit');
    await expect(page.locator('#btn-play')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: '상점', exact: true }).click();
    await expect(page.locator('#lb-credits')).toBeVisible();
    await page.screenshot({ path: 'test-results/shop.png' });
    if (DEV_SECRET_CODE) {
      await page.click('#btn-support');
      await page.fill('#sup-input', DEV_SECRET_CODE); await page.click('#sup-send');
      await expect(page.locator('#sup-title')).toHaveText('개발자 모드', { timeout: 15_000 });
      await page.getByRole('button', { name: '계정 스킨 관리' }).click();
      await page.fill('#sk-q', E2E_USER!); await page.click('#sk-search');
      await expect(page.locator('#sk-status')).toContainText('조회 완료', { timeout: 15_000 });
      await page.screenshot({ path: 'test-results/dev-skins.png' });
      await page.click('#dev-exit');
    }
    expect(errors, `페이지 예외: ${errors.join(' | ')}`).toEqual([]);
  });
});
