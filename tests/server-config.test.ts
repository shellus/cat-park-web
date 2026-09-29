import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadConfig, parseConfig } from '../server/config.ts';

test('config defaults resolve database paths from the fixed root and disable voice', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cat-config-'));
  try {
    const config = loadConfig(root);
    assert.equal(config.voice, undefined);
    assert.equal(config.game.maxPartySize, 6);
    assert.equal(config.database.path, resolve(root, 'data/game.sqlite'));
    writeFileSync(resolve(root, 'config.yaml'), 'version: 1\ndatabase:\n  path: nested/identity.sqlite\n');
    assert.equal(loadConfig(root).database.path, resolve(root, 'nested/identity.sqlite'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('config rejects unsupported versions, unknown keys, aliases, duplicate keys and unsafe YAML', () => {
  for (const text of [
    'version: 2',
    'version: 1\nunknown: 2',
    'version: 1\nversion: 1',
    'version: 1\n---\nversion: 1',
    'version: 1\nserver: &a { host: local }\ndatabase: *a',
    'version: 1\n__proto__: {}',
    'version: 1\nserver: { constructor: x }',
    'version: 1\nserver: { <<: { port: 1 } }',
    'version: 1\nserver: { port: 70000 }',
    'version: 1\nvoice: { url: https://example.test, apiKey: test, apiSecret: synthetic-test-secret }',
    'version: 1\nvoice: { url: wss://example.test, apiKey: test, apiSecret: synthetic-test-secret, local: { unknown: true } }',
    'version: 1\nvoice: { url: wss://example.test, apiKey: test, apiSecret: synthetic-test-secret, local: { enabled: true } }',
    `version: 1\n#${'x'.repeat(65536)}`,
  ])
    assert.throws(() => parseConfig(text));
  assert.equal(
    parseConfig(
      'version: 1\nvoice:\n  url: wss://example.test\n  apiUrl: https://example.test\n  apiKey: test\n  apiSecret: synthetic-test-secret\n',
    ).voice?.url,
    'wss://example.test',
  );
  assert.deepEqual(parseConfig('version: 1\nserver: { allowedHosts: [game.example.test] }').server.allowedHosts, [
    'game.example.test',
  ]);
  assert.deepEqual(parseConfig('version: 1').server.allowedHosts, []);
  const tunneled = parseConfig(`version: 1
voice:
  url: wss://voice.example.com
  apiUrl: http://127.0.0.1:7880
  apiKey: test
  apiSecret: synthetic-test-secret
  local:
    nodeIp: 203.0.113.10
    tcpPort: 17881
    udpPort: 17882
`);
  assert.deepEqual(tunneled.voice?.local, { enabled: true, nodeIp: '203.0.113.10', tcpPort: 17881, udpPort: 17882 });
});
