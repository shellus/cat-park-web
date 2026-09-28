import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAlias, isMap, isScalar, parseAllDocuments, visit } from 'yaml';
import { z } from 'zod';

export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const voiceSchema = z.strictObject({
  url: z.url().refine(value => /^wss?:/.test(value), 'voice.url 必须是 ws/wss URL'),
  apiUrl: z.url().refine(value => /^https?:/.test(value), 'voice.apiUrl 必须是 http/https URL').optional(),
  apiKey: z.string().min(1), apiSecret: z.string().min(16),
  local: z.strictObject({
    // Explicit local mode allows the browser-facing URL to be public WSS while
    // npm start still launches the local SFU used by the tunnel.
    enabled: z.boolean().default(true),
    nodeIp: z.string().min(1).default('127.0.0.1'),
    tcpPort: z.int().min(1).max(65535).default(7881),
    udpPort: z.int().min(1).max(65535).default(7882),
  }).optional(),
}).superRefine((value, context) => {
  if (value.local?.enabled && !value.apiUrl) {
    context.addIssue({ code: 'custom', path: ['apiUrl'], message: '启用 voice.local 时必须配置本地 voice.apiUrl' });
  }
});
export const configSchema = z.strictObject({
  version: z.literal(1),
  server: z.strictObject({
    host: z.string().min(1).default('127.0.0.1'), port: z.int().min(0).max(65535).default(3000),
    // External preview hostnames accepted by the integrated Vite dev server.
    allowedHosts: z.array(z.string().min(1)).default([]),
  }).default({ host: '127.0.0.1', port: 3000, allowedHosts: [] }),
  database: z.strictObject({ path: z.string().min(1).default('data/game.sqlite') }).default({ path: 'data/game.sqlite' }),
  game: z.strictObject({
    maxPartySize: z.int().min(2).max(12).default(6),
    maxPlayers: z.int().min(2).max(500).default(100),
    reconnectSeconds: z.number().min(0.1).max(120).default(30),
    // Offline cats stay greyed out in the lobby for this long, newest first up to the limit.
    offlineHours: z.number().min(0).max(720).default(24),
    offlineLimit: z.int().min(0).max(200).default(30),
  }).default({ maxPartySize: 6, maxPlayers: 100, reconnectSeconds: 30, offlineHours: 24, offlineLimit: 30 }),
  // Private local asset package directory, resolved from the project root.
  assets: z.strictObject({ package: z.string().min(1) }).optional(),
  voice: voiceSchema.optional(),
});
export type AppConfig = z.infer<typeof configSchema>;

export function parseConfig(source: string): AppConfig {
  if (Buffer.byteLength(source, 'utf8') > 64 * 1024) throw new Error('配置文件超过 64 KiB');
  const documents = parseAllDocuments(source, { version: '1.2', uniqueKeys: true, strict: true, merge: false });
  if (documents.length !== 1 || documents[0].errors.length) throw new Error('配置必须是无重复键的单个 YAML 1.2 文档');
  const document = documents[0];
  visit(document, (_key, node) => {
    if (isAlias(node)) throw new Error('配置不允许 YAML alias');
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('配置键必须为字符串');
      if (['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value)) throw new Error('配置含有不允许的对象键');
    }
  });
  const result = configSchema.safeParse(document.toJS({ maxAliasCount: 0 }));
  if (!result.success) {
    // Report paths, never print submitted credential values.
    throw new Error(`配置不符合 version: 1 Schema：${result.error.issues.map(issue => issue.path.join('.') || '(root)').join(', ')}`);
  }
  return result.data;
}

export function loadConfig(root = PROJECT_ROOT): AppConfig {
  const file = resolve(root, 'config.yaml');
  if (!existsSync(file)) return resolveConfigPaths(configSchema.parse({ version: 1 }), root);
  if (statSync(file).size > 64 * 1024) throw new Error('配置文件超过 64 KiB');
  return resolveConfigPaths(parseConfig(readFileSync(file, 'utf8')), root);
}

export function resolveConfigPaths(config: AppConfig, root = PROJECT_ROOT): AppConfig {
  return { ...config, database: { path: config.database.path === ':memory:' || isAbsolute(config.database.path) ? config.database.path : resolve(root, config.database.path) } };
}
