import test from 'node:test';
import assert from 'node:assert/strict';
import { Arena, SUPPLY } from '../dist/engine.mjs';
import { RoundTracker, ProgressionStore, ROUND_SECONDS } from '../dist/progression.mjs';

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-7, `${actual} should equal ${expected}`);
const rankings = arena => arena.ranking().map(({ holder, mass }) => ({ id: holder.id, name: holder.name, isPlayer: holder.isPlayer, mass }));

function scene({ playerMass = 900, opponentMass = 800 } = {}) {
  const arena = new Arena(() => .5);
  arena.holders = []; arena.food = []; arena.reserve = SUPPLY;
  arena.addFood = () => false;
  const player = arena.addHolder('player', '#73a7ed', playerMass, 1000, 1000, true, 'player-wallet');
  const opponent = arena.addHolder('opponent', '#c3f774', opponentMass, 2500, 1800, false, 'opponent-wallet');
  arena.player = player; arena.peak = playerMass;
  opponent.cells[0].thinkAt = Infinity;
  opponent.cells[0].target = { x: 2500, y: 1800 };
  return { arena, player, opponent, round: new RoundTracker() };
}

function step({ arena, round }, elapsed, paused = false) {
  if (paused || arena.dead || round.done) return;
  const played = Math.min(elapsed, .1, round.remaining);
  arena.advance(played, { target: arena.center() });
  round.update(played, rankings(arena));
}

function memoryStorage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test('real holder rankings preserve one score and combined mass when the player splits', () => {
  const state = scene();
  const id = state.player.id;
  for (let i = 0; i < 600; i++) step(state, .1);
  const before = state.round.standings().find(entry => entry.id === id);
  close(before.points, 100);
  assert.equal(state.arena.split({ x: 1400, y: 1000 }).ok, true);
  assert.equal(state.player.cells.length, 2);
  assert(state.player.cells.every(cell => cell.mass < state.opponent.cells[0].mass));
  assert.equal(rankings(state.arena)[0].id, id, 'ranking must use holder mass rather than individual cell mass');
  for (let i = 0; i < 600; i++) step(state, .1);
  const after = state.round.standings().find(entry => entry.id === id);
  close(after.points, 200);
  close(after.activeSeconds, 120);
  assert.equal(after.meanRank, 1);
  assert.equal(state.round.standings().length, 2);
  assert.equal(state.player.cells.length, 2, 'cosmetic scoring must not trigger consolidation');
  close(state.arena.mass(state.player), 900);
  close(state.arena.totalMass(), SUPPLY);
});

test('a complete arena round stops at six active minutes and pauses preserve both clocks and supply', () => {
  const state = scene();
  for (let i = 0; i < 300; i++) step(state, .1);
  const paused = { time: state.arena.time, score: state.round.snapshot() };
  for (let i = 0; i < 50; i++) step(state, 10, true);
  assert.equal(state.arena.time, paused.time);
  assert.deepEqual(state.round.snapshot(), paused.score);
  for (let i = 0; i < 4000; i++) step(state, .1);
  assert.equal(state.round.done, true);
  assert.equal(state.round.remaining, 0);
  close(state.arena.time, ROUND_SECONDS);
  const result = state.round.standings().find(entry => entry.id === state.player.id);
  close(result.activeSeconds, ROUND_SECONDS);
  close(result.points, 600);
  const finished = { time: state.arena.time, score: state.round.snapshot() };
  step(state, 60);
  assert.equal(state.arena.time, finished.time);
  assert.deepEqual(state.round.snapshot(), finished.score);
  close(state.arena.totalMass(), SUPPLY);
});

test('actual player absorption stops scoring and banks the player record once to its original profile', () => {
  const state = scene({ opponentMass: 2000 });
  const id = state.player.id;
  for (let i = 0; i < 600; i++) step(state, .1);
  const earned = state.round.standings().find(entry => entry.id === id);
  close(earned.points, 81);
  const attacker = state.opponent.cells[0], victim = state.player.cells[0];
  attacker.x = victim.x; attacker.y = victim.y;
  attacker.target = { x: victim.x, y: victim.y };
  step(state, .04);
  assert.equal(state.arena.dead, true);
  assert.equal(state.player.cells.length, 0);
  assert.equal(state.arena.events.filter(event => event.type === 'death').length, 1);
  assert.deepEqual(state.round.standings().find(entry => entry.id === id), earned);
  const ended = { time: state.arena.time, score: state.round.snapshot() };
  for (let i = 0; i < 100; i++) step(state, .1);
  assert.equal(state.arena.time, ended.time);
  assert.deepEqual(state.round.snapshot(), ended.score);

  const storage = memoryStorage(), store = new ProgressionStore(storage);
  const originalProfile = 'wallet-A';
  const record = { id: 'ended-round', activeSeconds: earned.activeSeconds, points: earned.points, peakShare: state.arena.peak / SUPPLY * 100 };
  const saved = store.record(originalProfile, record);
  close(saved.xp, 30.25);
  close(saved.points, 81);
  assert.equal(saved.rounds, 1);
  assert.deepEqual(store.record(originalProfile, record), saved, 'leave or retry cannot credit an already banked round');
  assert.deepEqual(new ProgressionStore(storage).record(originalProfile, record), saved, 'reload or page restoration cannot credit it again');
  assert.equal(store.load('wallet-B').xp, 0);
  assert.equal(store.load('guest').xp, 0);
  close(state.arena.totalMass(), SUPPLY);
});
