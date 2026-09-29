import { readFile, readdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { loadConfig } from '../server/config.ts';
import { diagnosticDirectory } from '../server/diagnostics.ts';
import type { StoredDiagnostic } from '../shared/diagnostics.ts';

const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
if (args.includes('--help')) {
  console.log(
    'npm run diagnostics -- [--user ID] [--source voice] [--since ISO_DATE] [--code 调试报告编号] [--limit 20] [--directory PATH]',
  );
  process.exit(0);
}
const directory = option('--directory') || diagnosticDirectory(loadConfig().database.path);
const limit = Math.max(1, Math.min(500, Number(option('--limit') || 20)));
if (!Number.isFinite(limit)) throw new Error('--limit must be a number');
const files = (
  await readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  })
)
  .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
  .sort()
  .reverse();
const events: StoredDiagnostic[] = [];
for (const name of files) {
  for (const line of (await readFile(resolve(directory, name), 'utf8')).trim().split('\n').reverse()) {
    if (!line) continue;
    let event: StoredDiagnostic;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (option('--user') && event.verifiedUserId !== option('--user') && event.context.userId !== option('--user'))
      continue;
    if (option('--source') && !event.source.includes(option('--source')!)) continue;
    if (option('--since') && event.receivedAt < option('--since')!) continue;
    if (
      option('--code') &&
      (event.details as { data?: { code?: string } })?.data?.code !== option('--code')!.toUpperCase()
    )
      continue;
    events.push(event);
    if (events.length >= limit) break;
  }
  if (events.length >= limit) break;
}
for (const event of events) {
  const resolvedStack: unknown[] = [];
  const stacks = new Set<string>();
  const collectStacks = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'stack' && typeof item === 'string') stacks.add(item);
      else if (item && typeof item === 'object') collectStacks(item);
    }
  };
  if (event.stack) stacks.add(event.stack);
  collectStacks(event.details);
  // Match Chrome/Edge/Firefox/Safari HTTP stack frames, mapping columns from 1-based to 0-based.
  for (const stack of stacks)
    for (const match of stack.matchAll(/https?:\/\/[^\s)]+\/([^/\s():]+\.js):(\d+):(\d+)/g)) {
      if (!/^[\w.-]+$/.test(event.build)) continue;
      try {
        const map = new TraceMap(
          JSON.parse(
            await readFile(
              resolve('.runtime/client-sourcemaps', event.build, 'assets', `${basename(match[1])}.map`),
              'utf8',
            ),
          ),
        );
        resolvedStack.push({
          generated: match[0],
          original: originalPositionFor(map, { line: Number(match[2]), column: Number(match[3]) - 1 }),
        });
      } catch {
        /* Old/development builds may not have maps on this machine. */
      }
    }
  console.log(JSON.stringify({ ...event, resolvedStack }, null, 2));
}
if (!events.length) console.log('没有匹配的前端异常记录。');
