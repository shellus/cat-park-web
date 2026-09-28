import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const credentialKey = 'catpark.credentials.v1';
async function credentials(page: Page): Promise<{ userId: string; password: string }> {
  await expect.poll(() => page.evaluate(key => localStorage.getItem(key), credentialKey)).not.toBeNull();
  return page.evaluate(key => JSON.parse(localStorage.getItem(key)!), credentialKey);
}
async function enter(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('game-canvas')).toHaveAttribute('data-world', 'lobby');
  await expect(page.locator('canvas')).toBeVisible();
  await credentials(page);
}
async function holdMoves(page: Page, key: string) {
  const canvas = page.locator('canvas');
  await expect(canvas).toHaveAttribute('data-predicted', 'true');
  const before = Number(await canvas.getAttribute('data-self-y'));
  await page.keyboard.down(key); await page.waitForTimeout(300); await page.keyboard.up(key);
  return Math.abs(Number(await canvas.getAttribute('data-self-y')) - before);
}
async function peer(context: BrowserContext) {
  const page = await context.newPage();
  await enter(page);
  return page;
}

test('two independent players: public chat, real SFU audio, auto-ready cancellation and start', async ({ page, browser }) => {
  const failures: string[] = [];
  page.on('pageerror', error => failures.push(error.message));
  await enter(page);
  const first = await credentials(page);
  const secondContext = await browser.newContext({ permissions: ['microphone'], baseURL: new URL(page.url()).origin });
  try {
    const second = await peer(secondContext);
    const other = await credentials(second);
    expect(first.userId).not.toEqual(other.userId);
    await page.getByTestId('chat-input').fill('一起荡秋千，测试消息');
    await page.getByTestId('chat-send').click();
    await expect(second.getByRole('log')).toContainText('一起荡秋千，测试消息');

    await page.getByTestId('create-party').click();
    await page.getByRole('button', { name: /在线玩家/ }).click();
    await page.getByTestId(`invite-player-${other.userId}`).click();
    await second.locator('[data-testid^="accept-invite-"]').first().click();
    await page.getByTestId('mic-check').click();
    await second.getByTestId('mic-check').click();
    await expect(page.getByTestId('start-game')).toBeEnabled({ timeout: 30_000 });

    await second.getByTestId('cancel-ready').click();
    await expect(page.getByTestId('start-game')).toBeDisabled();
    await second.getByTestId('mic-check').click();
    await expect(second.getByTestId('ready')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('start-game')).toBeDisabled();
    await second.reload();
    await expect(second.getByTestId('ready')).toBeVisible();
    await second.getByTestId('mic-check').click();
    await expect(second.getByTestId('ready')).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByTestId('start-game')).toBeDisabled();
    await second.getByTestId('ready').click();
    await expect(page.getByTestId('start-game')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('start-game').click();
    await expect(page.getByTestId('game-canvas')).toHaveAttribute('data-world', 'challenge');
    await expect(second.getByTestId('game-canvas')).toHaveAttribute('data-world', 'challenge');
    // Holding a direction moves continuously and the own cat is drawn from local prediction.
    const canvas = page.locator('canvas');
    await expect(canvas).toHaveAttribute('data-predicted', 'true');
    const startX = Number(await canvas.getAttribute('data-self-x'));
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(700);
    const heldX = Number(await canvas.getAttribute('data-self-x'));
    await page.keyboard.up('ArrowRight');
    expect(heldX - startX).toBeGreaterThan(300);
    await page.keyboard.press('Space');
    expect(failures).toEqual([]);
  } finally { await secondContext.close(); }
});

test('saved identity survives reload and password change replaces browser credentials', async ({ page, request }) => {
  await enter(page);
  const original = await credentials(page);
  await page.reload();
  await expect(page.getByTestId('game-canvas')).toHaveAttribute('data-world', 'lobby');
  expect((await credentials(page)).userId).toBe(original.userId);
  await page.getByTestId('settings').click();
  await page.getByRole('tab', { name: '账号与密码' }).click();
  const nextPassword = 'test-new-password-2026';
  await page.getByTestId('password-current').fill(original.password);
  await page.getByTestId('password-new').fill(nextPassword);
  await page.getByTestId('password-submit').click();
  await expect.poll(async () => (await credentials(page)).password).toBe(nextPassword);
  const denied = await request.post('/api/account/login', { data: original });
  expect(denied.status()).toBe(401);
  const allowed = await request.post('/api/account/login', { data: { userId: original.userId, password: nextPassword } });
  expect(allowed.ok()).toBe(true);
});

test('holding a key keeps the lobby cat moving without waiting for the server', async ({ page }) => {
  await enter(page);
  await page.mouse.click(700, 300);
  // Lobby speed is 680 units/s; the spawn has open grass below it.
  expect(await holdMoves(page, 'ArrowDown')).toBeGreaterThan(120);
});

test('denied microphone remains visibly unready', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Permission denied by test device', 'NotAllowedError'); };
  });
  await enter(page);
  await page.getByTestId('create-party').click();
  await page.getByTestId('mic-check').click();
  await expect(page.getByText(/麦克风权限.*拒绝|未允许.*麦克风|未授权.*麦克风|请允许.*麦克风/).first()).toBeVisible();
  await expect(page.getByTestId('start-game')).toBeDisabled();
});

test('desktop and mobile layouts render the original scene without page overflow', async ({ page, browser }) => {
  mkdirSync('.impeccable/review', { recursive: true });
  await enter(page);
  await page.screenshot({ path: '.impeccable/review/desktop.png', fullPage: true });
  const mobile = await browser.newContext({ baseURL: new URL(page.url()).origin, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1, permissions: ['microphone'] });
  try {
    const phone = await peer(mobile);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: '.impeccable/review/mobile.png', fullPage: true });
    await phone.setViewportSize({ width: 844, height: 390 });
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: '.impeccable/review/mobile-landscape.png', fullPage: true });
  } finally { await mobile.close(); }
});
