import { test as setup } from '@playwright/test';

const authFile = 'playwright/.auth/user.json';

setup('authenticate as admin', async ({ page }) => {
  await page.goto('/login');
  await page.locator('input[type="email"], input[name="email"]').fill('admin@smartbill.com');
  await page.locator('input[type="password"], input[name="password"]').fill('password123');
  await page.getByRole('button', { name: /sign in|log in|submit/i }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'));

  // Save the logged-in cookies so ALL tests can use them!
  await page.context().storageState({ path: authFile });
});
