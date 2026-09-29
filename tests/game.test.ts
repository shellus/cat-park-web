import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSimulation } from '../shared/simulation.ts';
import { RopeModel } from '../shared/game-rope.ts';
import { GAME_RULES as R } from '../shared/game-behavior.ts';
import type { InputState, PlayerProfile } from '../shared/protocol.ts';
import { LocalPlayer } from '../src/game/prediction.ts';
import type { GameContent } from '../shared/game-content.ts';

const profile = (id: string): PlayerProfile => ({ id, nickname: id, characterId: 'cat', color: '#f5cb62' });
test('tension spring is slack at rest, finite under large stretches, and pulls toward partner', () => {
  const rope = new RopeModel();
  const a = { position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, mass: 1 };
  assert.deepEqual(rope.force(a, { ...a, position: { x: 300, y: 0 } }), { x: 0, y: 0 });
  const stretched = rope.force(a, { ...a, position: { x: 1e9, y: -1e9 } });
  assert.ok(stretched.x > 0 && stretched.y < 0);
  assert.ok(Math.hypot(stretched.x, stretched.y) <= R.rope.maxAcceleration + 1e-6);
});

test('prepared content preserves real layered characters, lobby affine transforms and stage identity', async () => {
  const content: GameContent = JSON.parse(await readFile('public/game/content.json', 'utf8'));
  assert.equal(content.characters.length, 12);
  assert.equal(
    content.characters.reduce((sum, c) => sum + c.animations.length, 0),
    61,
  );
  assert.equal(content.challenge.name, '荡秋千');
  assert.equal(content.challenge.objects.length, 15);
  const door = content.challenge.objects.find(object => object.type === 3);
  assert.ok(door?.openedSprite, 'door must include the recovered opened-state sprite');
  assert.notEqual(door?.openedSprite, door?.sprite, 'door open and closed states must use different sprites');
  assert.ok(content.lobby.visuals.length > 6000);
  assert.ok(content.lobby.colliders.some(c => c.kind === 'polyline'));
  assert.ok(content.characters.find(c => c.id === 'cat')!.layers.length >= 2);
  assert.ok(content.lobby.visuals.some(v => v.matrix[0] < 0 || v.matrix[1] !== 0 || v.matrix[2] !== 0));
  const catalog = JSON.parse(await readFile('public/game/catalog.json', 'utf8'));
  assert.deepEqual(
    catalog.characters.map((c: { id: string }) => c.id),
    content.characters.map(c => c.id),
  );
  await readFile('public/game/fonts/game.woff2');
  // Every sprite resolves to a frame inside a known atlas page, and each load boundary lists its pages.
  for (const item of Object.values(content.sprites)) {
    const atlas = content.atlases[item.atlas];
    assert.ok(
      atlas &&
        item.frame.x >= 0 &&
        item.frame.y >= 0 &&
        item.frame.x + item.width <= atlas.width &&
        item.frame.y + item.height <= atlas.height,
    );
  }
  assert.ok(Object.keys(content.atlases).length < 30, 'sprites must be packed instead of shipped one file each');
  for (const character of content.characters) assert.ok(character.atlases.length > 0);
  assert.ok(
    content.lobby.atlases.every(id => content.atlases[id]) &&
      content.challenge.atlases.every(id => content.atlases[id]),
  );
});

test('two-player stage settles, holds jump only once, rejects nonfinite input and reconnects rope order', async () => {
  const simulation = await createSimulation('challenge');
  try {
    simulation.addPlayer(profile('a'));
    simulation.addPlayer(profile('b'));
    for (let i = 0; i < 120; i++) simulation.step(R.fixedStep);
    const start = simulation.snapshot().players[0];
    assert.ok(start.grounded, 'player settles on starting platform');
    simulation.setInput('a', { x: 0, y: 0, jump: true, sequence: 1 });
    let peak = start.y;
    for (let i = 0; i < 300; i++) {
      simulation.step(R.fixedStep);
      peak = Math.max(peak, simulation.snapshot().players[0].y);
    }
    const landed = simulation.snapshot().players[0];
    assert.ok(peak > start.y + 180, 'jump moves upward');
    assert.ok(Math.abs(landed.y - start.y) < 20, 'held jump does not auto-repeat on landing');
    simulation.setInput('a', { x: NaN, y: Infinity, jump: true, sequence: 2 });
    simulation.step(0.1);
    assert.ok(simulation.snapshot().players.every(p => [p.x, p.y, p.vx, p.vy].every(Number.isFinite)));
    simulation.addPlayer(profile('c'));
    simulation.removePlayer('b');
    assert.deepEqual(simulation.snapshot().ropes, [{ a: 'a', b: 'c' }]);
  } finally {
    simulation.dispose();
    simulation.dispose();
  }
});

test('fixed-step accumulation produces equivalent snapshots and falling restores a safe checkpoint', async () => {
  const a = await createSimulation('challenge'),
    b = await createSimulation('challenge');
  try {
    a.addPlayer(profile('a'));
    b.addPlayer(profile('a'));
    for (let i = 0; i < 60; i++) a.step(1 / 30);
    for (let i = 0; i < 120; i++) b.step(1 / 60);
    assert.deepEqual(a.snapshot(), b.snapshot());
    // Repeated rightward jumps traverse the first platforms; a missed landing eventually respawns.
    let previous = a.snapshot().players[0],
      respawned = false,
      sequence = 0;
    for (let i = 0; i < 2400; i++) {
      a.setInput('a', { x: 1, y: 0, jump: i % 110 === 0, sequence: ++sequence });
      a.step(R.fixedStep);
      const now = a.snapshot().players[0];
      assert.ok([now.x, now.y, now.vx, now.vy].every(Number.isFinite));
      if (previous.y < -1400 && now.y - previous.y > 500) {
        respawned = true;
        break;
      }
      previous = now;
    }
    assert.ok(respawned, 'falling out of stage must restore a safe checkpoint');
  } finally {
    a.dispose();
    b.dispose();
  }
});

test('a two-player rope remains finite through repeated opposing movement and jumps', async () => {
  const simulation = await createSimulation('challenge');
  try {
    simulation.addPlayer(profile('a'));
    simulation.addPlayer(profile('b'));
    for (let i = 0; i < 2400; i++) {
      simulation.setInput('a', { x: i % 600 < 300 ? 1 : -1, y: 0, jump: i % 90 === 0, sequence: i });
      simulation.setInput('b', { x: i % 500 < 250 ? -1 : 1, y: 0, jump: i % 120 === 0, sequence: i });
      simulation.step(R.fixedStep);
      const actors = simulation.snapshot().players;
      assert.ok(actors.every(p => [p.x, p.y, p.vx, p.vy].every(Number.isFinite)));
      assert.ok(actors.every(p => Math.abs(p.x) < 15000 && p.y > R.challenge.deathY));
      assert.ok(Math.hypot(actors[0].x - actors[1].x, actors[0].y - actors[1].y) < 5000);
    }
  } finally {
    simulation.dispose();
  }
});

test('lobby permits top-down movement and stops with neutral input', async () => {
  const simulation = await createSimulation('lobby');
  try {
    simulation.addPlayer(profile('a'));
    const start = simulation.snapshot().players[0];
    simulation.setInput('a', { x: -1, y: -1, jump: false, sequence: 1 });
    for (let i = 0; i < 45; i++) simulation.step(R.fixedStep);
    const moved = simulation.snapshot().players[0];
    assert.ok(Math.hypot(moved.x - start.x, moved.y - start.y) > 80);
    simulation.setInput('a', { x: 0, y: 0, jump: false, sequence: 2 });
    for (let i = 0; i < 30; i++) simulation.step(R.fixedStep);
    assert.ok(Math.hypot(simulation.snapshot().players[0].vx, simulation.snapshot().players[0].vy) < 1);
    simulation.setInput('a', { x: -1, y: 0, jump: false, sequence: 0 });
    for (let i = 0; i < 10; i++) simulation.step(R.fixedStep);
    assert.ok(simulation.snapshot().players[0].vx < -50, 'reconnected input sequences may restart');
  } finally {
    simulation.dispose();
  }
});

test('client prediction moves immediately and converges to the authoritative server over latency', async () => {
  const content: GameContent = JSON.parse(await readFile('public/game/content.json', 'utf8'));
  const server = await createSimulation('challenge'),
    local = new LocalPlayer(content);
  await local.ready;
  try {
    server.addPlayer(profile('a'));
    server.addPlayer(profile('b'));
    for (let i = 0; i < 120; i++) server.step(R.fixedStep);
    const LATENCY = 6; // ticks each way (~100 ms)
    const upstream: { at: number; input: InputState }[] = [],
      downstream: { at: number; snapshot: ReturnType<typeof server.snapshot> & { ack: number } }[] = [];
    let ack = -1,
      tick = 0,
      shownAtFirstPress: number | undefined,
      startX = server.snapshot().players[0].x,
      predictedX = startX;
    local.reconcile({ ...server.snapshot(), ack }, 'a');
    for (; tick < 600; tick++) {
      const held = tick < 240;
      const pose = local.frame(
        R.fixedStep,
        () => ({ x: held ? 1 : 0, y: 0, jump: tick === 60 }),
        input => upstream.push({ at: tick + LATENCY, input }),
        'a',
      );
      if (pose) predictedX = pose.x;
      if (tick === 10) shownAtFirstPress = predictedX; // first ack only arrives after 2 x LATENCY
      while (upstream[0]?.at <= tick) {
        const { input } = upstream.shift()!;
        server.setInput('a', input);
        ack = input.sequence;
      }
      server.step(R.fixedStep);
      if (tick % 3 === 0) downstream.push({ at: tick + LATENCY, snapshot: { ...server.snapshot(), ack } });
      while (downstream[0]?.at <= tick) local.reconcile(downstream.shift()!.snapshot, 'a');
    }
    assert.ok(shownAtFirstPress! > startX + 50, 'own cat moves before any server acknowledgement');
    const truth = server.snapshot().players[0];
    assert.ok(Math.abs(predictedX - truth.x) < 5, `prediction ${predictedX} converges to server ${truth.x}`);
  } finally {
    server.dispose();
    local.dispose();
  }
});
