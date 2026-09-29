import { appendFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import express from 'express';
import { z } from 'zod';
import type { AccountStore } from './accounts.ts';
import type { StoredDiagnostic } from '../shared/diagnostics.ts';

const eventSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  occurredAt: z.iso.datetime(),
  build: z.string().min(1).max(150),
  source: z.string().min(1).max(100),
  message: z.string().max(8000),
  stack: z.string().max(16000).optional(),
  context: z.record(z.string(), z.unknown()),
  environment: z.record(z.string(), z.unknown()),
  details: z.unknown(),
  breadcrumbs: z.array(z.object({ at: z.iso.datetime(), source: z.string().max(100), details: z.unknown() })).max(30),
});
export const diagnosticDirectory = (databasePath: string) => join(dirname(databasePath), 'client-errors');

/** Serialized bounded JSONL writer. A full/erroring disk never crashes the game process. */
export class DiagnosticStore {
  private tail: Promise<unknown> = Promise.resolve();
  private seen = new Set<string>();
  private day = '';
  constructor(
    readonly directory: string,
    private maxBytes = 10 * 1024 * 1024,
  ) {}
  write(event: StoredDiagnostic): Promise<void> {
    const task = this.tail.then(async () => {
      const day = new Date().toISOString().slice(0, 10),
        file = join(this.directory, `${day}.jsonl`);
      await mkdir(this.directory, { recursive: true });
      if (day !== this.day) {
        this.seen.clear();
        const old = await readFile(file, 'utf8').catch(() => '');
        for (const line of old.split('\n')) {
          try {
            this.seen.add(JSON.parse(line).id);
          } catch {
            /* incomplete last line */
          }
        }
        const cutoff = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
        for (const name of await readdir(this.directory))
          if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && name.slice(0, 10) < cutoff)
            await rm(join(this.directory, name));
        this.day = day;
      }
      if (this.seen.has(event.id)) return;
      const line = `${JSON.stringify(event)}\n`,
        size = (await stat(file).catch(() => null))?.size ?? 0;
      if (size + Buffer.byteLength(line) > this.maxBytes) throw new Error('Client diagnostic daily size limit reached');
      await appendFile(file, line, 'utf8');
      this.seen.add(event.id);
    });
    this.tail = task.catch(() => undefined);
    return task;
  }
  async close() {
    await this.tail;
  }
}

export function createDiagnosticsApi(accounts: AccountStore, store: DiagnosticStore) {
  const router = express.Router(),
    rates = new Map<string, { count: number; expires: number }>();
  router.use((_request, response, next) => {
    response.setHeader('Cache-Control', 'no-store');
    next();
  });
  router.post('/', express.json({ limit: '64kb', strict: true }), async (request, response) => {
    const parsed = z.object({ event: eventSchema, authToken: z.string().max(128).optional() }).safeParse(request.body);
    if (!parsed.success) {
      response.status(400).json({ error: 'Invalid diagnostic report' });
      return;
    }
    const { event, authToken } = parsed.data;
    const now = Date.now(),
      key = request.socket.remoteAddress || 'unknown';
    for (const [address, rate] of rates) if (rate.expires < now) rates.delete(address);
    const rate = rates.get(key) ?? { count: 0, expires: now + 60_000 };
    if ((rates.size >= 2048 && !rates.has(key)) || ++rate.count > 240) {
      response.status(429).setHeader('Retry-After', '60').end();
      return;
    }
    rates.set(key, rate);
    const account = accounts.authenticate(authToken);
    try {
      await store.write({
        ...event,
        receivedAt: new Date().toISOString(),
        verifiedUserId: account?.profile.id ?? null,
        remoteAddress: key,
        forwardedFor: request.get('x-forwarded-for') ?? null,
        userAgent: request.get('user-agent') ?? '',
      });
      response.status(202).json({ id: event.id });
    } catch (error) {
      console.error('Client diagnostic persistence failed:', error);
      response.status(503).json({ error: 'Diagnostic storage unavailable' });
    }
  });
  router.use(((error, _request, response, _next) => {
    response.status(error?.type === 'entity.too.large' ? 413 : 400).json({ error: 'Invalid diagnostic body' });
  }) as express.ErrorRequestHandler);
  return router;
}
