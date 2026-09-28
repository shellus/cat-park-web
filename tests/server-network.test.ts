import test from 'node:test';
import assert from 'node:assert/strict';
import { Client, type Room } from '@colyseus/sdk';
import { AccountStore } from '../server/accounts.ts';
import { configSchema } from '../server/config.ts';
import { createBackend } from '../server/index.ts';
import type { GameSimulation } from '../server/simulation.ts';
import type { AuthResult, ErrorNotice, InputState, PlayerProfile, SocialState, WorldKind, WorldSnapshot } from '../shared/protocol.ts';

async function waitFor(check: () => boolean, label: string, timeout = 4000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail(`Timed out: ${label}`);
}
function simulation(kind: WorldKind): GameSimulation {
  const players = new Map<string, PlayerProfile>(), positions = new Map<string, number>(), inputs = new Map<string, InputState>();
  return {
    addPlayer(profile) { players.set(profile.id, profile); positions.set(profile.id, 0); },
    removePlayer(id) { players.delete(id); positions.delete(id); },
    updateProfile(profile) { if (players.has(profile.id)) players.set(profile.id, profile); },
    setInput(id, input) { if (input.sequence >= (inputs.get(id)?.sequence ?? -1)) inputs.set(id, input); },
    step(dt) { for (const id of players.keys()) positions.set(id, (positions.get(id) || 0) + (inputs.get(id)?.x || 0) * dt); },
    snapshot() { return { kind, tick: 0, elapsed: 0, players: [...players.values()].map(profile => ({ ...profile, x: positions.get(profile.id) || 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true })), ropes: [], keyOwnerId: null, collectedStars: [], doorOpen: false, won: false }; },
    dispose() {},
  };
}
interface Observer { room: Room; social?: SocialState; world?: WorldSnapshot; errors: ErrorNotice[]; closed?: number }
function observe(room: Room): Observer {
  const observer: Observer = { room, errors: [] };
  room.onMessage('social', (state: SocialState) => { observer.social = state; });
  room.onMessage('world', (state: WorldSnapshot) => { observer.world = state; });
  room.onMessage('error', (error: ErrorNotice) => observer.errors.push(error));
  room.onMessage('voice', () => {});
  room.onLeave(code => { observer.closed = code; });
  return observer;
}

test('HTTP accounts and real Colyseus clients share one park, recover identity and enforce team rules', async t => {
  const characters = [{ id: 'fixture-cat', name: '测试猫', preview: '/fixture.png' }];
  const accounts = new AccountStore(':memory:', characters, 4);
  const denied = new Set<string>();
  const backend = await createBackend({
    config: configSchema.parse({ version: 1, server: { port: 0 }, database: { path: ':memory:' } }),
    accounts, characters, frontend: 'none', simulationFactory: async kind => simulation(kind),
    voice: { available: true, async grant(partyId) { return { partyId, url: 'ws://example.test', token: 'synthetic-test-token' }; }, async verify(_party, id) { return !denied.has(id); }, async remove() {}, close() {} },
  });
  const port = await backend.listen(), base = `http://127.0.0.1:${port}`;
  const observers: Observer[] = [];
  t.after(async () => {
    await Promise.all(observers.filter(observer => observer.closed === undefined).map(observer => observer.room.leave().catch(() => {})));
    await backend.close(); accounts.close();
  });
  const request = async (path: string, body?: unknown, token?: string, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const guests = await Promise.all([0, 1].map(async () => { const response = await request('/api/account/guest'); assert.equal(response.status, 201); return response.json() as Promise<AuthResult>; }));
  const health = await fetch(`${base}/api/health`).then(response => response.json()) as { ok: boolean };
  assert.equal(health.ok, true);
  const client = new Client(base);
  await assert.rejects(client.joinOrCreate('park', { token: 'invalid-token' }));
  const first = observe(await client.joinOrCreate('park', { token: guests[0].token })); observers.push(first);
  const second = observe(await new Client(base).joinOrCreate('park', { token: guests[1].token })); observers.push(second);
  assert.equal(first.room.roomId, second.room.roomId);
  await waitFor(() => first.social?.players.length === 2 && second.social?.players.length === 2, 'initial social state');
  first.room.send('action', { type: 'party.invite', userId: guests[1].profile.id });
  await waitFor(() => Boolean(second.social?.invitations.length), 'targeted invitation');
  second.room.send('action', { type: 'party.accept', invitationId: second.social!.invitations[0].id });
  await waitFor(() => first.social?.party?.members.length === 2 && second.social?.party?.members.length === 2, 'party accepted');
  const report = { status: 'ok', hasSignal: true, voiceConnected: true, published: true };
  first.room.send('action', { type: 'mic', report }); second.room.send('action', { type: 'mic', report });
  await waitFor(() => Boolean(first.social?.party?.members.every(member => member.ready)), 'both ready');
  second.room.send('action', { type: 'party.start' });
  await waitFor(() => second.errors.some(error => error.code === 'leader_only'), 'leader enforcement');
  denied.add(guests[1].profile.id);
  first.room.send('action', { type: 'party.start' });
  await waitFor(() => first.errors.some(error => error.code === 'voice_check_failed'), 'real start gate');
  assert.equal(first.social!.party!.phase, 'forming');
  denied.clear(); second.room.send('action', { type: 'mic', report });
  await waitFor(() => Boolean(first.social?.party?.members.every(member => member.ready)), 'voice recovery');
  first.room.send('action', { type: 'party.start' });
  await waitFor(() => first.world?.kind === 'challenge' && second.world?.kind === 'challenge', 'two player start');
  second.room.send('action', { type: 'party.ready', ready: false });
  await waitFor(() => second.social?.party?.members.find(member => member.id === guests[1].profile.id)?.autoReady === false, 'cancellation latch');

  await t.test('password HTTP rotation revokes old sessions and active room access', async () => {
    const response = await request('/api/account/password', { currentPassword: guests[1].credentials!.password, newPassword: 'replacement-password' }, guests[1].token);
    assert.equal(response.status, 200);
    const updated = await response.json() as AuthResult;
    await waitFor(() => second.closed !== undefined, 'old socket closed after rotation');
    assert.equal((await request('/api/account/profile', { nickname: '旧会话' }, guests[1].token, 'PATCH')).status, 401);
    assert.equal((await request('/api/account/login', guests[1].credentials)).status, 401);
    const recovered = await request('/api/account/login', { userId: guests[1].profile.id, password: 'replacement-password' });
    assert.equal(recovered.status, 200);
    const replacement = observe(await new Client(base).joinOrCreate('park', { token: updated.token })); observers.push(replacement);
    await waitFor(() => Boolean(replacement.social), 'reconnect social');
    // Reconnect with a fresh token recovers the same reserved party and world.
    assert.equal(replacement.social!.self.id, guests[1].profile.id);
    assert.equal(replacement.social!.party!.id, first.social!.party!.id);
    replacement.room.send('action', { type: 'mic', report });
    await waitFor(() => replacement.social!.party!.members.find(member => member.id === guests[1].profile.id)?.mic.status === 'ok', 'microphone recheck');
    assert.equal(replacement.social!.party!.members.find(member => member.id === guests[1].profile.id)!.ready, false);
    const profile = await request('/api/account/profile', { nickname: '重新连接的小猫' }, updated.token, 'PATCH');
    assert.equal(profile.status, 200);
    await waitFor(() => first.social!.players.some(player => player.nickname === '重新连接的小猫'), 'profile broadcast');
  });
});
