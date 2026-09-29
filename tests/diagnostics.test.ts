import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { AccountStore } from '../server/accounts.ts';
import { createDiagnosticsApi, DiagnosticStore } from '../server/diagnostics.ts';
import type { ClientDiagnostic, StoredDiagnostic } from '../shared/diagnostics.ts';

const event = (): ClientDiagnostic => ({
  id: randomUUID(),
  sessionId: randomUUID(),
  occurredAt: new Date().toISOString(),
  build: 'test-build',
  source: 'voice.connect',
  message: 'could not establish pc connection',
  stack: 'Error: connection failed',
  context: { userId: 'claimed-user' },
  environment: { userAgent: 'Android Edge', online: true },
  details: { remoteCandidate: { address: '203.0.113.10', port: 61002, protocol: 'udp' }, stage: 'signal-connected' },
  breadcrumbs: [],
});

test('diagnostic HTTP ingestion records anonymous/bootstrap and authenticated failures, deduplicates retries, rejects oversized input', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'catpark-diagnostics-'));
  const store = new DiagnosticStore(directory);
  const accounts = new AccountStore(':memory:', [{ id: 'cat', name: 'Cat', preview: '/cat.png' }], 4);
  const app = express();
  app.use('/api/client-errors', createDiagnosticsApi(accounts, store));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await store.close();
    accounts.close();
    await rm(directory, { recursive: true });
  });
  const address = server.address() as { port: number },
    base = `http://127.0.0.1:${address.port}/api/client-errors`;
  const send = (body: unknown) =>
    fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-forwarded-for': '198.51.100.22' },
      body: JSON.stringify(body),
    });
  const anonymous = event(),
    authenticated = event(),
    guest = await accounts.guest();
  assert.equal((await send({ event: anonymous })).status, 202);
  assert.equal((await send({ event: authenticated, authToken: guest.token })).status, 202);
  assert.equal((await send({ event: authenticated, authToken: guest.token })).status, 202);
  assert.equal((await send({ event: { ...event(), source: '' } })).status, 400);
  assert.equal((await send({ event: { ...event(), details: 'x'.repeat(70_000) } })).status, 413);
  const file = join(directory, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const text = await readFile(file, 'utf8'),
    records: StoredDiagnostic[] = text
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].verifiedUserId, null);
  assert.equal(records[1].verifiedUserId, guest.profile.id);
  assert.deepEqual(records[0].details, anonymous.details);
  assert.equal(records[0].forwardedFor, '198.51.100.22');
  assert.ok(records[0].receivedAt);
  assert.ok(!text.includes(guest.token), 'transport authentication is not part of stored diagnostics');
  const reopened = new DiagnosticStore(directory);
  await reopened.write(records[1]);
  await reopened.close();
  assert.equal(
    (await readFile(file, 'utf8')).trim().split('\n').length,
    2,
    'pagehide retries survive server restart without duplicate rows',
  );
  const full = new DiagnosticStore(directory, 1);
  await assert.rejects(full.write({ ...records[0], id: randomUUID() }), /daily size limit/);
  await full.close();
  assert.equal((await fetch(base)).status, 404, 'logs cannot be queried over the public ingest route');
});
