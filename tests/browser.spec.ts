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
  await page.keyboard.down(key);
  await page.waitForTimeout(300);
  await page.keyboard.up(key);
  return Math.abs(Number(await canvas.getAttribute('data-self-y')) - before);
}
async function peer(context: BrowserContext) {
  const page = await context.newPage();
  await enter(page);
  return page;
}

test('two independent players: public chat, real SFU audio, auto-ready cancellation and start', async ({
  page,
  browser,
}) => {
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
    await expect(page.getByTestId(`invited-player-${other.userId}`)).toBeVisible();
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
  } finally {
    await secondContext.close();
  }
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
  const allowed = await request.post('/api/account/login', {
    data: { userId: original.userId, password: nextPassword },
  });
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
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission denied by test device', 'NotAllowedError');
    };
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
  const mobile = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
    permissions: ['microphone'],
  });
  try {
    const phone = await peer(mobile);
    // Portrait is not laid out: a full-screen hint asks to rotate, and it goes away in landscape.
    await expect(phone.getByTestId('rotate-hint')).toBeVisible();
    // A browser tab keeps its toolbars even in landscape, so the hint also suggests installing.
    await expect(phone.getByTestId('install-hint')).toBeVisible();
    await phone.screenshot({ path: '.impeccable/review/mobile-portrait.png' });
    await phone.setViewportSize({ width: 844, height: 390 });
    await expect(phone.getByTestId('rotate-hint')).toBeHidden();
    // On a short landscape screen the prompts must not cover the party panel's action button.
    const partyAction = phone.getByTestId('create-party');
    const box = (await partyAction.boundingBox())!;
    for (const x of [box.x + 8, box.x + box.width / 2, box.x + box.width - 8]) {
      expect(
        await phone.evaluate(([x, y]) => !!document.elementFromPoint(x, y)?.closest('[data-testid="create-party"]'), [
          x,
          box.y + box.height / 2,
        ] as const),
      ).toBe(true);
    }
    // Landscape in a browser tab still suggests installing, once, until dismissed.
    await expect(phone.getByTestId('install-tip')).toBeVisible();
    await phone.getByTestId('install-tip').getByRole('button', { name: '不再提示' }).click();
    await phone.reload();
    await expect(phone.getByTestId('game-canvas')).toHaveAttribute('data-world', 'lobby');
    await expect(phone.getByTestId('install-tip')).toHaveCount(0);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: '.impeccable/review/mobile-landscape.png', fullPage: true });
  } finally {
    await mobile.close();
  }
});

test('an optional username becomes a second login name and the first-entry prompt can be dismissed', async ({
  page,
  request,
}) => {
  await enter(page);
  const original = await credentials(page);
  await page.getByTestId('username-prompt-open').click();
  const username = `cat_${Date.now().toString(36)}`;
  await page.getByTestId('username-input').fill(username);
  await page.getByTestId('username-submit').click();
  await expect(page.getByText(`以后可以用“${username}”和密码登录。`)).toBeVisible();
  const byName = await request.post('/api/account/login', {
    data: { userId: username.toUpperCase(), password: original.password },
  });
  expect(byName.ok()).toBe(true);
  expect((await byName.json()).profile.id).toBe(original.userId);
  await page.keyboard.press('Escape');
  await page.reload();
  await expect(page.getByTestId('game-canvas')).toHaveAttribute('data-world', 'lobby');
  await expect(page.getByTestId('username-prompt-open')).toHaveCount(0);
});

test('a player whose microphone is denied can still ready after confirming', async ({ page, browser }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission denied by test device', 'NotAllowedError');
    };
  });
  await enter(page);
  const secondContext = await browser.newContext({ permissions: ['microphone'], baseURL: new URL(page.url()).origin });
  try {
    const second = await peer(secondContext);
    await page.getByTestId('create-party').click();
    await page.getByRole('button', { name: /在线玩家/ }).click();
    await page.getByTestId(`invite-player-${(await credentials(second)).userId}`).click();
    await second.locator('[data-testid^="accept-invite-"]').first().click();
    await second.getByTestId('mic-check').click();
    await page.getByTestId('mic-check').click();
    await page.getByTestId('ready-without-mic').click();
    await page.getByTestId('confirm-micless').click();
    await expect(second.getByText('不开麦参加，队友听不到 TA')).toBeVisible();
    await expect(page.getByTestId('start-game')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('start-game').click();
    await expect(second.getByTestId('game-canvas')).toHaveAttribute('data-world', 'challenge');
  } finally {
    await secondContext.close();
  }
});

test('touch: a tap walks the cat to the spot and a held drag steers like a joystick', async ({ browser, baseURL }) => {
  const mobile = await browser.newContext({
    baseURL,
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });
  try {
    const phone = await peer(mobile);
    const canvas = phone.locator('canvas');
    await expect(canvas).toHaveAttribute('data-predicted', 'true');
    const position = async () => ({
      x: Number(await canvas.getAttribute('data-self-x')),
      y: Number(await canvas.getAttribute('data-self-y')),
    });
    // Real touch points through CDP, so the browser produces genuine pointer events and capture.
    const cdp = await mobile.newCDPSession(phone);
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
    let before = await position();
    await touch('touchStart', 422, 370);
    await touch('touchEnd', 422, 370);
    await expect.poll(async () => before.y - (await position()).y, { timeout: 5000 }).toBeGreaterThan(120);
    before = await position();
    await touch('touchStart', 422, 195);
    for (const x of [412, 397, 377]) await touch('touchMove', x, 195);
    await expect(phone.locator('.game-stick')).toBeVisible();
    await phone.waitForTimeout(500);
    await touch('touchEnd', 377, 195);
    expect(before.x - (await position()).x).toBeGreaterThan(100);
    await expect(phone.locator('.game-stick')).toHaveCount(0);
  } finally {
    await mobile.close();
  }
});

test('touch in a challenge: arrow buttons and the centre stick move sideways, the jump button works alongside', async ({
  page,
  browser,
  baseURL,
}) => {
  await enter(page);
  const mobile = await browser.newContext({
    baseURL,
    viewport: { width: 844, height: 390 },
    isMobile: true,
    hasTouch: true,
    permissions: ['microphone'],
  });
  try {
    const phone = await peer(mobile);
    await page.getByTestId('create-party').click();
    await page.getByRole('button', { name: /在线玩家/ }).click();
    await page.getByTestId(`invite-player-${(await credentials(phone)).userId}`).click();
    await phone.locator('[data-testid^="accept-invite-"]').first().click();
    // The leader has no ready button of its own; a verified microphone is enough.
    await expect(page.getByTestId('ready')).toHaveCount(0);
    await expect(page.getByTestId('cancel-ready')).toHaveCount(0);
    await page.getByTestId('mic-check').click();
    const toggle = phone.locator('.party-heading-toggle');
    if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
    await phone.getByTestId('mic-check').click();
    await expect(page.getByTestId('start-game')).toBeEnabled({ timeout: 30_000 });
    await page.getByTestId('start-game').click();
    await expect(phone.getByTestId('game-canvas')).toHaveAttribute('data-world', 'challenge');
    await toggle.click();
    const canvas = phone.locator('canvas');
    await expect(canvas).toHaveAttribute('data-predicted', 'true');
    // Nothing may cover the pad: each control must be the element under its own centre.
    for (const id of ['pad-left', 'pad-stick', 'pad-right', 'pad-jump']) {
      const box = (await phone.getByTestId(id).boundingBox())!;
      expect(
        await phone.evaluate(
          ([x, y, testId]) => !!document.elementFromPoint(x, y)?.closest(`[data-testid="${testId}"]`),
          [box.x + box.width / 2, box.y + box.height / 2, id] as const,
        ),
      ).toBe(true);
    }
    const x = async () => Number(await canvas.getAttribute('data-self-x'));
    const cdp = await mobile.newCDPSession(phone);
    const center = async (id: string) => {
      const box = (await phone.getByTestId(id).boundingBox())!;
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    };
    const touch = (type: 'touchStart' | 'touchMove' | 'touchEnd', points: { x: number; y: number; id: number }[]) =>
      cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points });
    // Holding the left arrow while tapping jump with a second finger.
    const left = await center('pad-left'),
      jump = await center('pad-jump');
    let before = await x();
    await touch('touchStart', [{ ...left, id: 1 }]);
    await phone.waitForTimeout(300);
    await touch('touchStart', [
      { ...left, id: 1 },
      { ...jump, id: 2 },
    ]);
    await touch('touchEnd', [{ ...left, id: 1 }]);
    await phone.waitForTimeout(300);
    await touch('touchEnd', []);
    expect(before - (await x())).toBeGreaterThan(80);
    // Dragging the centre stick to the right.
    await phone.waitForTimeout(800);
    const stick = await center('pad-stick');
    before = await x();
    await touch('touchStart', [{ ...stick, id: 3 }]);
    for (const dx of [10, 25, 40]) await touch('touchMove', [{ x: stick.x + dx, y: stick.y, id: 3 }]);
    await phone.waitForTimeout(600);
    await touch('touchEnd', []);
    expect((await x()) - before).toBeGreaterThan(80);
    // Touching the scene itself no longer opens the floating joystick in a challenge.
    await touch('touchStart', [{ x: 422, y: 195, id: 4 }]);
    await touch('touchMove', [{ x: 377, y: 195, id: 4 }]);
    await expect(phone.locator('.game-stick')).toHaveCount(0);
    await touch('touchEnd', []);
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ path: '.impeccable/review/mobile-challenge-pad.png' });
  } finally {
    await mobile.close();
  }
});

test('an offline player stays in the lobby greyed out instead of disappearing', async ({ page, browser }) => {
  await enter(page);
  const otherContext = await browser.newContext({ baseURL: new URL(page.url()).origin });
  const other = await peer(otherContext);
  const { userId } = await credentials(other);
  await otherContext.close();
  // The test instance keeps a reconnect seat for a few seconds, then leaves an offline cat.
  await page.getByRole('button', { name: /在线玩家/ }).click();
  await expect(page.getByTestId(`invite-player-${userId}`)).toHaveCount(0, { timeout: 15_000 });
  await expect.poll(() => page.locator('canvas').getAttribute('data-offline-ids')).toContain(userId);
  await page.screenshot({ path: '.impeccable/review/offline-cat.png' });
});
