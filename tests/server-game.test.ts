import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore } from '../server/accounts.ts';
import { configSchema } from '../server/config.ts';
import { GameService, type Connection } from '../server/game-service.ts';
import type { GameSimulation } from '../server/simulation.ts';
import type { VoiceService } from '../server/voice.ts';
import type { ActorSnapshot, InputState, PlayerProfile, WorldKind, WorldSnapshot } from '../shared/protocol.ts';

class Simulation implements GameSimulation {
  players = new Map<string, PlayerProfile>();
  inputs = new Map<string, InputState>();
  disposed = false;
  constructor(public kind: WorldKind) {}
  addPlayer(profile: PlayerProfile) { this.players.set(profile.id, profile); }
  removePlayer(id: string) { this.players.delete(id); }
  updateProfile(profile: PlayerProfile) { if (this.players.has(profile.id)) this.players.set(profile.id, profile); }
  setInput(id: string, input: InputState) {
    if ((this.inputs.get(id)?.sequence ?? -1) > input.sequence) return;
    this.inputs.set(id, input);
  }
  step() {}
  snapshot(): WorldSnapshot { return { kind: this.kind, tick: 0, elapsed: 0, players: [...this.players.values()].map(profile => ({ ...profile, x: 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true } satisfies ActorSnapshot)), ropes: [], keyOwnerId: null, collectedStars: [], doorOpen: false, won: false }; }
  dispose() { this.disposed = true; }
}
class Voice implements VoiceService {
  available = true;
  failed = new Set<string>();
  checks: string[] = [];
  removed: string[] = [];
  async grant(partyId: string) { return { partyId, url: 'ws://example.test', token: 'synthetic-test-token' }; }
  async verify(_party: string, id: string) { this.checks.push(id); return !this.failed.has(id); }
  async remove(partyId: string, id: string) { this.removed.push(`${partyId}:${id}`); }
  close() {}
}
function connection(id: string) {
  return { id, events: [] as { type: string; value: any }[], closes: [] as number[], send(type, value) { this.events.push({ type, value }); }, close(code) { this.closes.push(code); } } satisfies Connection & { events: { type: string; value: any }[]; closes: number[] };
}
const good = { status: 'ok', hasSignal: true, voiceConnected: true, published: true } as const;
async function fixture(count = 3) {
  const accounts = new AccountStore(':memory:', [{ id: 'fixture-cat', name: '测试猫', preview: '/fixture.png' }], 4);
  const voice = new Voice(), lobby = new Simulation('lobby');
  const simulations: Simulation[] = [];
  const config = configSchema.parse({ version: 1, game: { reconnectSeconds: 0.1 } });
  const service = new GameService(accounts, config, voice, lobby, async kind => { const simulation = new Simulation(kind); simulations.push(simulation); return simulation; });
  const users = await Promise.all(Array.from({ length: count }, () => accounts.guest()));
  const connections = users.map((user, index) => { const channel = connection(`connection-${index}`); service.connect(user.profile.id, channel); return channel; });
  return { accounts, voice, lobby, service, users, connections, simulations, send: (index: number, action: unknown) => service.handle(users[index].profile.id, connections[index].id, action), social: (index: number) => service.socialFor(users[index].profile.id), close() { service.dispose(); accounts.close(); } };
}
async function pair(f: Awaited<ReturnType<typeof fixture>>) {
  await f.send(0, { type: 'party.invite', userId: f.users[1].profile.id });
  await f.send(1, { type: 'party.accept', invitationId: f.social(1).invitations[0].id });
  await f.send(0, { type: 'mic', report: good });
  await f.send(1, { type: 'mic', report: good });
}

test('two ready players can start; non-leader is rejected and chat remains public', async () => {
  const f = await fixture();
  try {
    await pair(f);
    assert(f.social(0).party!.members.every(member => member.ready));
    await f.send(1, { type: 'party.start' });
    assert.equal(f.social(0).party!.phase, 'forming');
    assert.equal(f.connections[1].events.at(-1)!.value.code, 'leader_only');
    const previousChecks = f.voice.checks.length;
    await f.send(0, { type: 'party.start' });
    assert.equal(f.voice.checks.length - previousChecks, 2);
    assert.equal(f.social(0).party!.phase, 'playing');
    assert.equal(f.simulations[0].players.size, 2);
    assert.equal(f.lobby.players.size, 1);
    await f.send(2, { type: 'chat', text: '大厅里也能和游戏里的朋友聊天' });
    assert.equal(f.social(0).chat.at(-1)!.userId, f.users[2].profile.id);
    assert.equal(f.social(0).players.find(player => player.id === f.users[2].profile.id)!.world, 'lobby');
    await f.send(1, { type: 'party.return' });
    assert.equal(f.social(0).party!.phase, 'forming');
    assert(f.simulations[0].disposed);
    assert.equal(f.lobby.players.size, 3);
  } finally { f.close(); }
});

test('any disconnect during a game ends the whole party simulation immediately', async () => {
  const f = await fixture(2);
  try {
    await pair(f);
    await f.send(0, { type: 'party.start' });
    assert.equal(f.social(0).party!.phase, 'playing');
    f.service.disconnect(f.users[1].profile.id, f.connections[1].id);
    assert.equal(f.social(0).party!.phase, 'forming');
    assert(f.simulations[0].disposed);
    assert.equal(f.service.worldCount, 0);
    assert.equal(f.lobby.players.size, 2);
    assert.equal(f.social(0).players.find(player => player.id === f.users[0].profile.id)!.world, 'lobby');
  } finally { f.close(); }
});

test('manual cancellation persists across microphone recovery, party rejoin and reconnect', async () => {
  const f = await fixture(2);
  try {
    await pair(f);
    await f.send(1, { type: 'party.ready', ready: false });
    await f.send(1, { type: 'mic', report: { ...good, status: 'missing', hasSignal: false } });
    await f.send(1, { type: 'mic', report: good });
    assert.equal(f.social(1).party!.members[1].ready, false);
    const inviteCode = f.social(0).party!.inviteCode;
    await f.send(1, { type: 'party.leave' });
    await f.send(1, { type: 'party.accept', inviteCode });
    await f.send(1, { type: 'mic', report: good });
    assert.equal(f.social(1).party!.members[1].autoReady, false);
    f.service.disconnect(f.users[1].profile.id, f.connections[1].id);
    f.service.connect(f.users[1].profile.id, f.connections[1]);
    await f.send(1, { type: 'mic', report: good });
    assert.equal(f.social(1).party!.members[1].ready, false);
    await f.send(1, { type: 'party.ready', ready: true });
    assert.equal(f.social(1).party!.members[1].ready, true);
    assert.equal(f.accounts.get(f.users[1].profile.id)!.autoReady, true);
  } finally { f.close(); }
});

test('server voice failure revokes ready and blocks start despite an optimistic client report', async () => {
  const f = await fixture(2);
  try {
    await pair(f);
    f.voice.failed.add(f.users[1].profile.id);
    await f.send(0, { type: 'party.start' });
    assert.equal(f.social(0).party!.phase, 'forming');
    assert.equal(f.social(1).party!.members[1].ready, false);
    assert.equal(f.social(1).party!.members[1].mic.status, 'disconnected');
    assert.equal(f.social(1).party!.members[1].autoReady, true);
    assert.equal(f.simulations.length, 0);
    f.voice.failed.clear();
    await f.send(1, { type: 'mic', report: good });
    assert.equal(f.social(1).party!.members[1].ready, true);
    f.voice.available = false;
    await f.send(1, { type: 'party.ready', ready: true });
    assert.equal(f.social(1).party!.members[1].ready, false);
  } finally { f.close(); }
});

test('disconnect immediately neutralizes input; timeout transfers leadership and removes the voice member', async () => {
  const f = await fixture(2);
  try {
    await pair(f);
    await f.send(0, { type: 'input', input: { x: 1, y: 0, jump: true, sequence: 1 } });
    f.service.disconnect(f.users[0].profile.id, f.connections[0].id);
    assert.equal(f.lobby.inputs.get(f.users[0].profile.id)!.x, 0);
    assert.equal(f.social(1).party!.members[0].ready, false);
    assert.equal(f.service.onlineCount, 1);
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.social(1).party!.leaderId, f.users[1].profile.id);
    assert.equal(f.social(1).party!.members.length, 1);
    assert(f.voice.removed.some(key => key.endsWith(f.users[0].profile.id)));
  } finally { f.close(); }
});

test('one identity has one seat and a stale connection cannot mutate or remove its replacement', async () => {
  const f = await fixture(2);
  try {
    await pair(f);
    await f.send(0, { type: 'input', input: { x: 1, y: 0, jump: true, sequence: 100 } });
    const beforeReconnect = f.lobby.inputs.get(f.users[0].profile.id)!.sequence;
    const replacement = connection('replacement');
    f.service.connect(f.users[0].profile.id, replacement);
    assert.deepEqual(f.connections[0].closes, [4001]);
    assert.equal(f.service.onlineCount, 2);
    assert.equal(f.lobby.inputs.get(f.users[0].profile.id)!.x, 0);
    assert(f.lobby.inputs.get(f.users[0].profile.id)!.sequence > beforeReconnect);
    await f.service.handle(f.users[0].profile.id, replacement.id, { type: 'input', input: { x: -1, y: 0, jump: false, sequence: 0 } });
    f.service.step(1 / 60);
    assert.equal(f.lobby.inputs.get(f.users[0].profile.id)!.x, -1);
    await f.send(0, { type: 'party.disband' });
    f.service.disconnect(f.users[0].profile.id, f.connections[0].id, true);
    assert.equal(f.social(1).party!.members.length, 2);
    assert.equal(f.service.onlineCount, 2);
    await f.service.handle(f.users[0].profile.id, replacement.id, { type: 'input', input: { x: 999, y: 0, jump: false, sequence: 2 } });
    assert.equal(replacement.events.at(-1)!.value.code, 'invalid_message');
  } finally { f.close(); }
});

test('different teams receive separate worlds, can decline invitations and cannot join a running game', async () => {
  const f = await fixture(4);
  try {
    await pair(f);
    await f.send(2, { type: 'party.invite', userId: f.users[3].profile.id });
    const id = f.social(3).invitations[0].id;
    await f.send(3, { type: 'party.decline', invitationId: id });
    assert.equal(f.social(3).invitations.length, 0);
    await f.send(3, { type: 'party.accept', inviteCode: f.social(2).party!.inviteCode });
    await f.send(2, { type: 'mic', report: good }); await f.send(3, { type: 'mic', report: good });
    await Promise.all([f.send(0, { type: 'party.start' }), f.send(2, { type: 'party.start' })]);
    assert.equal(f.service.worldCount, 2);
    const a = f.connections[0].events.filter(event => event.type === 'world').at(-1)!.value as WorldSnapshot;
    const b = f.connections[2].events.filter(event => event.type === 'world').at(-1)!.value as WorldSnapshot;
    assert.equal(a.players.length, 2); assert.equal(b.players.length, 2);
    assert(!a.players.some(player => b.players.some(other => other.id === player.id)));
    await f.send(3, { type: 'party.leave' });
    await f.send(3, { type: 'party.accept', inviteCode: f.social(0).party!.inviteCode });
    assert.equal(f.connections[3].events.at(-1)!.value.code, 'party_playing');
    assert.equal(f.social(3).party, null);
  } finally { f.close(); }
});

test('inputs are simulated one per tick, acknowledged in snapshots and bounded under backlog', async () => {
  const f = await fixture(1);
  try {
    const id = f.users[0].profile.id;
    for (let sequence = 1; sequence <= 3; sequence++) await f.send(0, { type: 'input', input: { x: sequence === 2 ? 1 : 0, y: 0, jump: false, sequence } });
    f.service.step(1 / 60); f.service.step(1 / 60);
    assert.equal(f.lobby.inputs.get(id)!.x, 1, 'second tick consumes the second queued input');
    f.service.sendWorlds();
    assert.equal(f.connections[0].events.filter(event => event.type === 'world').at(-1)!.value.ack, 2);
    // A backlog is trimmed to a few ticks, but a jump press inside the dropped part survives.
    for (let sequence = 4; sequence <= 20; sequence++) await f.send(0, { type: 'input', input: { x: 0, y: 0, jump: sequence === 5, sequence } });
    f.service.step(1 / 60);
    assert.equal(f.lobby.inputs.get(id)!.jump, true);
    for (let i = 0; i < 10; i++) f.service.step(1 / 60);
    f.service.sendWorlds();
    assert.equal(f.connections[0].events.filter(event => event.type === 'world').at(-1)!.value.ack, 20);
  } finally { f.close(); }
});

test('a member may ready without a microphone; the choice survives mic reports and reconnects and allows start', async () => {
  const f = await fixture(2);
  try {
    await f.send(0, { type: 'party.invite', userId: f.users[1].profile.id });
    await f.send(1, { type: 'party.accept', invitationId: f.social(1).invitations[0].id });
    await f.send(0, { type: 'mic', report: good });
    await f.send(1, { type: 'mic', report: { status: 'denied', hasSignal: false, voiceConnected: false, published: false } });
    await f.send(1, { type: 'party.ready', ready: true });
    assert.equal(f.connections[1].events.at(-1)!.value.code, 'microphone_not_ready');
    await f.send(1, { type: 'party.ready', ready: true, withoutMic: true });
    const member = () => f.social(0).party!.members.find(item => item.id === f.users[1].profile.id)!;
    assert.equal(member().ready, true); assert.equal(member().micless, true);
    await f.send(1, { type: 'mic', report: { status: 'missing', hasSignal: false, voiceConnected: false, published: false } });
    f.service.disconnect(f.users[1].profile.id, f.connections[1].id);
    assert.equal(member().ready, false);
    f.service.connect(f.users[1].profile.id, f.connections[1]);
    assert.equal(member().ready, true);
    const checks = f.voice.checks.length;
    await f.send(0, { type: 'party.start' });
    assert.equal(f.social(0).party!.phase, 'playing');
    assert.deepEqual(f.voice.checks.slice(checks), [f.users[0].profile.id]);
    await f.send(1, { type: 'party.return' });
    // A working microphone later turns it back into a verified voice ready.
    await f.send(1, { type: 'mic', report: good });
    assert.equal(member().ready, true); assert.equal(member().micless, false);
    await f.send(1, { type: 'party.ready', ready: false });
    assert.equal(member().ready, false);
    await f.send(1, { type: 'party.leave' });
    assert.equal(f.social(1).party, null);
  } finally { f.close(); }
});

test('an expired player stays in the lobby as an offline cat until they return', async () => {
  const f = await fixture(2);
  try {
    const id = f.users[1].profile.id;
    f.service.disconnect(id, f.connections[1].id);
    const presence = f.social(0).players.find(player => player.id === id)!;
    assert.equal(presence.online, false); assert.equal(typeof presence.lastSeenAt, 'number');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(f.social(0).players.some(player => player.id === id), false);
    assert.deepEqual(f.social(0).offline.map(player => player.id), [id]);
    assert.equal(f.lobby.players.has(id), false);
    assert(f.accounts.recentlySeen(0, 10).some(player => player.id === id));
    f.service.connect(id, connection('back'));
    assert.equal(f.social(0).offline.length, 0);
  } finally { f.close(); }
});

test('a forming party leader sees who has a pending invitation until it is answered', async () => {
  const f = await fixture(3);
  try {
    await f.send(0, { type: 'party.create' });
    await f.send(0, { type: 'party.invite', userId: f.users[1].profile.id });
    await f.send(0, { type: 'party.invite', userId: f.users[2].profile.id });
    assert.deepEqual(f.social(0).party!.pending.map(item => item.userId).sort(), [f.users[1].profile.id, f.users[2].profile.id].sort());
    await f.send(1, { type: 'party.accept', invitationId: f.social(1).invitations[0].id });
    await f.send(2, { type: 'party.decline', invitationId: f.social(2).invitations[0].id });
    assert.deepEqual(f.social(0).party!.pending, []);
    assert.equal(f.social(0).party!.members.length, 2);
  } finally { f.close(); }
});
