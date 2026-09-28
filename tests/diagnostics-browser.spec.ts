import { test, expect } from '@playwright/test';

test('frontend reports global/resource/Promise failures and queues offline failures across reload', async ({ page }) => {
  const reports: { event: { id: string; source: string; message: string; context: Record<string, unknown>; environment: Record<string, unknown>; build: string } }[] = [];
  let blockReports = false;
  await page.route('**/api/client-errors', async route => {
    if (blockReports) { await route.abort(); return; }
    const body = route.request().postDataJSON();
    const response = await route.fetch();
    expect(response.status()).toBe(202); reports.push(body); await route.fulfill({ response });
  });
  await page.goto('/'); await expect(page.getByTestId('self-name')).toBeVisible();
  await page.evaluate(() => {
    setTimeout(() => { throw new Error('diagnostic-global-fixture'); }, 0);
    void Promise.reject(new Error('diagnostic-promise-fixture'));
    const image = new Image(); image.src = '/missing-diagnostic-fixture.png'; document.body.append(image);
  });
  await expect.poll(() => reports.some(item => item.event.source === 'window.error')).toBe(true);
  await expect.poll(() => reports.some(item => item.event.source === 'unhandledrejection')).toBe(true);
  await expect.poll(() => reports.some(item => item.event.source === 'resource.error')).toBe(true);
  const global = reports.find(item => item.event.source === 'window.error')!.event;
  expect(global.context.userId).toBeTruthy(); expect(global.environment.userAgent).toBeTruthy(); expect(global.build).toBeTruthy();
  blockReports = true;
  await page.evaluate(() => { setTimeout(() => { throw new Error('diagnostic-offline-fixture'); }, 0); });
  await expect.poll(() => page.evaluate(() => localStorage.getItem('catpark.diagnostics.v1'))).toContain('diagnostic-offline-fixture');
  await page.reload(); await expect(page.getByTestId('self-name')).toBeVisible();
  blockReports = false;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => reports.some(item => item.event.message === 'diagnostic-offline-fixture')).toBe(true);
  const offlineId = reports.find(item => item.event.message === 'diagnostic-offline-fixture')!.event.id;
  await expect.poll(() => page.evaluate(() => localStorage.getItem('catpark.diagnostics.v1'))).not.toContain(offlineId);
});

test('caught voice PeerConnection failures include the attempt, endpoint and connection history', async ({ page }) => {
  await page.addInitScript(() => {
    const NativePeerConnection = RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(configuration?: RTCConfiguration) { super(configuration); throw new Error('diagnostic-pc-connection-fixture'); }
    };
  });
  const reports: Record<string, any>[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/client-errors')) reports.push(request.postDataJSON().event); });
  await page.goto('/'); await expect(page.getByTestId('self-name')).toBeVisible();
  await page.getByTestId('create-party').click();
  await expect.poll(() => reports.find(event => event.source === 'voice.connect'), { timeout: 45_000 }).toBeTruthy();
  const report = reports.find(event => event.source === 'voice.connect')!;
  expect(report.details.data.attemptId).toBeTruthy();
  expect(report.details.data.url).toMatch(/^wss?:\/\//);
  expect(report.details.data.partyId).toBeTruthy();
  expect(report.details.data.elapsedMs).toBeGreaterThan(0);
  expect(report.breadcrumbs.some((item: { source: string }) => item.source.startsWith('voice.'))).toBe(true);
  expect(JSON.stringify(report)).not.toContain('access_token');
});
