import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { AccountStore } from '../server/accounts.ts';

const characters = [{ id: 'fixture-cat', name: '测试角色', preview: '/test.png' }];
test('generated accounts persist, recover after database reopen and preserve cancelled auto-ready', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cat-account-'));
  const path = resolve(root, 'account.sqlite');
  let store = new AccountStore(path, characters, 4);
  try {
    const guest = await store.guest();
    assert(guest.credentials);
    assert.match(guest.profile.nickname, /^[\p{Script=Han}]+$/u);
    assert.equal(store.authenticate(guest.token)?.profile.id, guest.profile.id);
    assert.equal(store.get(guest.profile.id)?.autoReady, true);
    store.setAutoReady(guest.profile.id, false);
    store.updateProfile(guest.profile.id, { nickname: '持久小猫' });
    store.close(); store = new AccountStore(path, characters, 4);
    const recovered = await store.login(guest.credentials.userId, guest.credentials.password);
    assert.equal(recovered.profile.nickname, '持久小猫');
    assert.equal(store.get(guest.profile.id)?.autoReady, false);
    assert.equal(store.authenticate(guest.token)?.profile.id, guest.profile.id);
    await assert.rejects(store.login(guest.profile.id, 'wrong-password'));
    assert.throws(() => store.updateProfile(guest.profile.id, { characterId: 'nonexistent' }));
    assert.throws(() => store.updateProfile(guest.profile.id, { nickname: 'a\n' }));
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('password rotation invalidates all previous sessions and rejects bcrypt truncation', async () => {
  const store = new AccountStore(':memory:', characters, 4);
  try {
    const first = await store.guest();
    const second = await store.login(first.credentials!.userId, first.credentials!.password);
    const password = '新密码猫咪'.repeat(3);
    const changed = await store.changePassword(first.profile.id, first.credentials!.password, password);
    assert.equal(changed.credentials?.password, password);
    assert.equal(store.authenticate(first.token), null);
    assert.equal(store.authenticate(second.token), null);
    assert.equal(store.authenticate(changed.token)?.profile.id, first.profile.id);
    await assert.rejects(store.login(first.profile.id, first.credentials!.password));
    assert.equal((await store.login(first.profile.id, password)).profile.id, first.profile.id);
    await assert.rejects(store.changePassword(first.profile.id, password, '猫'.repeat(25)));
    await assert.rejects(store.changePassword(first.profile.id, password, 'short'));
    const concurrent = await Promise.allSettled([
      store.changePassword(first.profile.id, password, 'replacement-one'),
      store.changePassword(first.profile.id, password, 'replacement-two'),
    ]);
    assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  } finally { store.close(); }
});

test('optional username logs in alongside the user ID, is unique case-insensitively and migrates old databases', async () => {
  const root = mkdtempSync(resolve(tmpdir(), 'cat-account-'));
  const path = resolve(root, 'account.sqlite');
  let store = new AccountStore(path, characters, 4);
  try {
    const [first, second] = [await store.guest(), await store.guest()];
    assert.equal(first.username, null);
    assert.equal(store.setUsername(first.profile.id, ' Mao_01 '), 'Mao_01');
    assert.throws(() => store.setUsername(second.profile.id, 'mao_01'), /已被使用/);
    assert.throws(() => store.setUsername(second.profile.id, 'ab'));
    assert.throws(() => store.setUsername(second.profile.id, 'has space'));
    const byName = await store.login('MAO_01', first.credentials!.password);
    assert.equal(byName.profile.id, first.profile.id);
    assert.equal(byName.username, 'Mao_01');
    await assert.rejects(store.login('Mao_01', second.credentials!.password));
    store.setLastSeen(first.profile.id, 1000, 12, -34);
    assert.deepEqual(store.recentlySeen(999, 10).map(player => [player.id, player.x, player.y]), [[first.profile.id, 12, -34]]);
    assert.equal(store.recentlySeen(1001, 10).length, 0);
    store.close(); store = new AccountStore(path, characters, 4);
    assert.equal((await store.login('mao_01', first.credentials!.password)).profile.id, first.profile.id);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
