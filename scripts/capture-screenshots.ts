import { chromium, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import testConfig from '../playwright.config.ts';
import { COLORS, type AuthResult } from '../shared/protocol.ts';

// Run against a dedicated local instance; this creates four temporary guest accounts.
const baseURL = process.env.SCREENSHOT_URL || 'http://localhost:3000';
const output = path.resolve('docs/screenshots');
await mkdir(output, { recursive: true });
const browser = await chromium.launch(testConfig.use?.launchOptions);
const errors: string[] = [];
const pages: Page[] = [];
const accounts: AuthResult[] = [];
try {
  for (const [index, nickname] of ['小橘', '团子', '奶糖', '薄荷'].entries()) {
    const mobile = index === 1;
    const context = await browser.newContext({ baseURL, permissions: ['microphone'],
      viewport: mobile ? { width: 844, height: 390 } : { width: 1440, height: 900 },
      isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1,
    });
    const response = await context.request.post('/api/account/guest');
    expect(response.ok()).toBeTruthy();
    const account: AuthResult = await response.json();
    accounts.push(account);
    const profile = await context.request.patch('/api/account/profile', {
      headers: { Authorization: `Bearer ${account.token}` },
      data: { nickname, characterId: 'cat', color: COLORS[index] },
    });
    expect(profile.ok()).toBeTruthy();
    await context.addInitScript(credentials => {
      localStorage.setItem('catpark.credentials.v1', JSON.stringify(credentials));
    }, account.credentials);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    pages.push(page);
    await page.goto('/');
    await expect(page.getByTestId('game-canvas')).toHaveAttribute('data-world', 'lobby');
    await expect(page.locator('canvas')).toHaveAttribute('data-self-x', /-?\d/, { timeout: 30_000 });
    await expect(page.locator('.game-load-state')).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('self-name')).toHaveText(nickname);
  }
  const [desktop, phone] = pages;
  await desktop.getByTestId('chat-input').fill('公园集合，一起去荡秋千！');
  await desktop.getByTestId('chat-send').click();
  await desktop.getByTestId('create-party').click();
  await desktop.getByRole('button', { name: /查看 4 位在线玩家/ }).click();
  for (let i = 1; i < pages.length; i++) {
    await desktop.getByTestId(`invite-player-${accounts[i].profile.id}`).click();
    await pages[i].locator('[data-testid^="accept-invite-"]').first().click();
  }
  // Every participant passes the same microphone + LiveKit publication check as a user.
  for (const page of pages) {
    const toggle = page.locator('.party-heading-toggle');
    if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
    await page.getByTestId('mic-check').click();
  }
  await expect(desktop.getByTestId('start-game')).toBeEnabled({ timeout: 45_000 });
  await desktop.getByRole('button', { name: '全员聊天', exact: true }).click();
  await phone.locator('.party-heading-toggle').click();
  await desktop.locator('canvas').click({ position: { x: 720, y: 350 } });
  await desktop.waitForTimeout(1500);
  await desktop.screenshot({ path: path.join(output, 'desktop-lobby.png') });
  await phone.screenshot({ path: path.join(output, 'mobile-lobby.png') });
  await desktop.getByTestId('start-game').click();
  for (const page of pages) {
    await expect(page.getByTestId('game-canvas')).toHaveAttribute('data-world', 'challenge');
    await expect(page.locator('.game-load-state')).toHaveCount(0);
  }
  // Let the four connected cats land on the starting platform with their ropes visible.
  await desktop.waitForTimeout(2000);
  await desktop.screenshot({ path: path.join(output, 'desktop-game.png') });
  await phone.screenshot({ path: path.join(output, 'mobile-game.png') });
  expect(errors).toEqual([]);
  for (const page of [desktop, phone]) {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  }
  console.log('Captured desktop/mobile lobby/game with four real players and active team voice.');
} finally {
  await browser.close();
}
